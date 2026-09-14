/**
 * AI instruction submission (Phase 10.22).
 *
 * The thin service behind `POST /api/ai/instructions`. It validates the
 * authenticated client's instruction request strictly, then delegates to the
 * EXISTING persistent agent-turn runtime (Phase 10.20) — no second agent
 * flow, no provider/fallback logic, and no tool policy here.
 *
 * Design rules:
 *
 *   - SINGLE AGENT ENTRY: the request is executed by the existing
 *     `PersistentAgentTurnRuntime` (`runPersistentTurn`), preserving the
 *     bounded loop, provider fallback/rotation/cooldown, conversation
 *     ownership checks, and the `invokeTool()`/policy pipeline verbatim.
 *   - STRICT BODY: only `conversationId` (optional), `approvalId` (optional,
 *     Phase 10.30 resume) and `instruction` (required) are accepted. Unknown
 *     fields — including any user id — are REJECTED, so a body can never
 *     override or influence the authenticated identity (which comes
 *     exclusively from the session).
 *   - VALIDATION CONVENTIONS: mirrors the existing auth-service style —
 *     module-level constants, `AppError.badRequest` with explicit messages.
 *   - SAFE RESPONSE: reuses the persisted `ConversationState` types. The
 *     transcript (`messages`) and scalar fields are echoed; tool RESULTS are
 *     reduced to `{ callId, ok }` so raw file content (e.g. `read_file`
 *     base64 payloads) can never leak to the client. No conversation is ever
 *     created or modified by this service itself.
 *   - ERROR MAPPING: known failures become safe, typed `AppError`s (404
 *     foreign conversation, 503 provider unavailable, 502 loop bound).
 *     Unexpected errors propagate UNCHANGED so the HTTP layer's existing
 *     generic `internal/error` envelope hides internals.
 *   - NO NETWORK HERE: this module performs no provider calls; the runtime
 *     it delegates to owns all provider access.
 */
import { AppError } from "../core/errors.js";
import { isConversationId } from "./conversationId.js";
import { AgentConversationNotFoundError } from "../database/repositories/agentConversations.js";
import { ToolRegistry } from "../tools/registry.js";
import { readToolDefinitions, registerReadTools } from "../tools/definitions/readTools.js";
import { writeToolDefinitions, registerWriteTools } from "../tools/definitions/writeTools.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { AgentMessage } from "./conversation.js";
import { isAgentLoopError } from "./agentLoop.js";
import { isProviderError } from "./provider.js";
import {
  ToolApprovalExpiredError,
  ToolApprovalNotFoundError,
  ToolApprovalNotExecutableError,
} from "./aiToolApprovals.js";
import type { ToolApprovalRequestInfo } from "./tools.js";
import {
  createPersistentTurnRuntime,
  type PersistentAgentTurnRuntime,
  type PersistentTurnInput,
  type PersistentTurnResult,
} from "./persistentAgentTurn.js";
import { composeDefaultProviderStack } from "./providerComposition.js";

// ---------------------------------------------------------------------------
// Validation constants (auth-service convention)
// ---------------------------------------------------------------------------

/** Reasonable server-side cap on a single instruction / prompt. */
export const MAX_INSTRUCTION_LENGTH = 4096;

/** Strict body shape: nothing outside these three fields is accepted. */
const BODY_FIELDS = new Set(["conversationId", "instruction", "approvalId"]);

/** Tool-loop bound applied when the host has not pre-bound a runtime. */
const MAX_TOOL_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Typed request / response
// ---------------------------------------------------------------------------

/** The ONLY fields accepted in `POST /api/ai/instructions`. */
export interface AiInstructionBody {
  /** Resume this conversation (ownership enforced). Omit to create a new one. */
  conversationId?: string;
  /** The authenticated user's instruction (required). */
  instruction: string;
  /**
   * Resume after an approval decision (Phase 10.30): the id of the owned,
   * `approved` tool approval whose EXACT stored arguments this turn should
   * execute. Optional.
   */
  approvalId?: string;
}

/** Safe outcome synopsis for one executed tool intent (payloads excluded). */
export interface AiToolOutcome {
  /** Matches the intent id in the transcript messages. */
  callId: string;
  /** Whether the intent executed successfully. */
  ok: boolean;
}

/**
 * The safe, stable per-turn result returned to the authenticated client. It
 * reuses the existing persisted `ConversationState` fields — the transcript
 * (`messages`), scalar progress fields, and `finalText` — plus `created`.
 * Tool RESULTS are deliberately reduced to `{ callId, ok }`; payload fields
 * (which can carry raw file contents) are never echoed. Pending approval
 * metadata is included when any tool required approval (Phase 10.29).
 */
export interface AiInstructionTurn {
  /** True when a new conversation was created for this turn. */
  created: boolean;
  /** The validated participant-visible instruction. */
  instruction: string;
  /** The persisted transcript, using the existing `AgentMessage` model. */
  messages: readonly AgentMessage[];
  /** The agent's final reply, once the turn completed. */
  finalText?: string;
  /** Number of tool-execution rounds performed (the bounded loop). */
  toolRounds: number;
  /** The loop bound in force for this turn. */
  maxToolRounds: number;
  /** Safe per-intent outcome synopsis; payloads are never included. */
  toolResults: readonly AiToolOutcome[];
  /**
   * Pending approval metadata collected during this turn (Phase 10.29).
   * Each entry contains safe metadata only: the persisted approval id, the
   * tool name, the schema-validated arguments stored in the approval, and
   * the expiry of the approval window. Empty when no tools required
   * approval. No raw file contents, provider responses, or secrets.
   */
  pendingApprovals: readonly ToolApprovalRequestInfo[];
}

/** Stable HTTP response for `POST /api/ai/instructions`. */
export interface AiInstructionResponse {
  /** The conversation id (existing or newly created). */
  conversationId: string;
  /** The safe, persisted turn result. */
  turn: AiInstructionTurn;
}

// ---------------------------------------------------------------------------
// Strict body validation
// ---------------------------------------------------------------------------

/**
 * Parse and strictly validate the request body. Rejects missing/empty/
 * whitespace-only/oversized instructions, a malformed conversation id, any
 * non-object body, and ANY unexpected field (a body-supplied user id is
 * rejected — identity comes from the session, never the body).
 *
 * @throws `AppError.badRequest` (400) on any violation.
 */
export function parseAiInstructionInput(raw: unknown): AiInstructionBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw AppError.badRequest("Request body must be a JSON object.");
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!BODY_FIELDS.has(key)) {
      throw AppError.badRequest(`Unexpected field "${key}" in request body.`);
    }
  }

  const instructionRaw = record.instruction;
  if (typeof instructionRaw !== "string") {
    throw AppError.badRequest("Instruction must be a string.");
  }
  const instruction = instructionRaw.trim();
  if (instruction.length === 0) {
    throw AppError.badRequest("Instruction must not be empty.");
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw AppError.badRequest(
      `Instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters long.`,
    );
  }

  let conversationId: string | undefined;
  if (record.conversationId !== undefined) {
    if (!isConversationId(record.conversationId)) {
      throw AppError.badRequest("A valid conversationId is required when resuming a conversation.");
    }
    conversationId = record.conversationId;
  }

  let approvalId: string | undefined;
  if (record.approvalId !== undefined) {
    if (!isConversationId(record.approvalId)) {
      throw AppError.badRequest("A valid approvalId is required when resuming an approval.");
    }
    approvalId = record.approvalId;
  }

  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(approvalId !== undefined ? { approvalId } : {}),
    instruction,
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map KNOWN agent/provider/application failures to safe, typed `AppError`s.
 *
 *   - `AppError`            → passthrough (already safe + enveloped).
 *   - `AgentConversationNotFoundError` → 404 `common/not-found` (a foreign
 *     conversation is indistinguishable from a missing one).
 *   - `ProviderError` (incl. the composition fallback exhaustion error) →
 *     503 `ai/provider-unavailable`, provider-agnostic message.
 *   - `AgentLoopError`      → 502 `ai/max-tool-rounds-reached`.
 *   - `ToolApprovalNotFoundError` (Phase 10.30) → 404 `common/not-found` (a
 *     foreign approval is indistinguishable from a missing one).
 *   - `ToolApprovalExpiredError` / `ToolApprovalNotExecutableError` (Phase
 *     10.30) → 400 `common/bad-request` (rejected / expired / consumed
 *     approvals never execute).
 *   - anything else         → returned UNCHANGED so the HTTP layer's generic
 *     `internal/error` envelope (no stack, no message) protects internals.
 */
export function mapAgentTurnError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof AgentConversationNotFoundError) {
    return AppError.notFound("Agent conversation");
  }
  if (isProviderError(error)) {
    return new AppError(
      503,
      "ai/provider-unavailable",
      "The AI provider is temporarily unavailable. Please try again later.",
    );
  }
  if (isAgentLoopError(error)) {
    return new AppError(
      502,
      "ai/max-tool-rounds-reached",
      "The agent exceeded the allowed number of tool rounds.",
    );
  }
  // Phase 10.30 resume failures: a missing/foreign approval is 404 (as
  // indistinguishable as a missing conversation); an expired or otherwise
  // non-executable approval is 400 and never executes.
  if (error instanceof ToolApprovalNotFoundError) {
    return AppError.notFound("Tool approval");
  }
  if (
    error instanceof ToolApprovalExpiredError ||
    error instanceof ToolApprovalNotExecutableError
  ) {
    return AppError.badRequest(error.message);
  }
  return error;
}

// ---------------------------------------------------------------------------
// Safe result shaping
// ---------------------------------------------------------------------------

function toAiInstructionTurn(result: PersistentTurnResult): AiInstructionTurn {
  return {
    created: result.created,
    instruction: result.state.instruction,
    messages: result.state.messages,
    ...(result.state.finalText !== undefined ? { finalText: result.state.finalText } : {}),
    toolRounds: result.state.toolRounds,
    maxToolRounds: result.state.maxToolRounds,
    // Never echo payload-bearing results (raw file content etc.).
    toolResults: result.state.toolResults.map((toolResult) => ({
      callId: toolResult.callId,
      ok: toolResult.ok,
    })),
    // Phase 10.29: safe pending approval metadata — approval id, tool name,
    // validated args, and expiry. No raw file contents or provider output.
    pendingApprovals: result.pendingApprovals,
  };
}

/** Shape the existing persisted turn result into the stable HTTP response. */
export function toAiInstructionResponse(result: PersistentTurnResult): AiInstructionResponse {
  return {
    conversationId: result.conversationId,
    turn: toAiInstructionTurn(result),
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Validate, execute, and shape one AI instruction through the EXISTING
 * persistent agent-turn runtime. The runtime is provided explicitly so tests
 * can inject the real Phase 10.20 runtime or a scripted fake.
 *
 * @throws `AppError.badRequest` on body-shape violations; thrown outcomes of
 *         `runtime.run` are mapped via `mapAgentTurnError`.
 */
export async function runAiInstructionWithRuntime(
  runtime: PersistentAgentTurnRuntime,
  c: { get: (key: string) => unknown },
  raw: unknown,
): Promise<AiInstructionResponse> {
  const input = parseAiInstructionInput(raw);

  const turnInput: PersistentTurnInput = {
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.approvalId !== undefined ? { resumeApprovalId: input.approvalId } : {}),
    instruction: input.instruction,
  };

  let result: PersistentTurnResult;
  try {
    result = await runtime.run(c, turnInput);
  } catch (error) {
    throw mapAgentTurnError(error);
  }

  return toAiInstructionResponse(result);
}

// ---------------------------------------------------------------------------
// Runtime seam (production binding)
// ---------------------------------------------------------------------------

let boundRuntime: PersistentAgentTurnRuntime | undefined;
let boundFilesystem: FilesystemExecutor | undefined;

/**
 * Bind the LONG-LIVED persistent agent-turn runtime used by the route. The
 * host composes this once at startup (e.g.
 * `createPersistentTurnRuntime({ stack: composeDefaultProviderStack(), ... })`)
 * so provider fallback/rotation/cooldown state survives across requests.
 * Pass `undefined` to clear (for tests).
 */
export function bindAiInstructionRuntime(runtime: PersistentAgentTurnRuntime | undefined): void {
  boundRuntime = runtime;
}

/**
 * Alternative seam: bind only the filesystem executor. The runtime is then
 * built lazily on first use from the default provider stack and registered
 * read-only tools. Pass `undefined` to clear (for tests).
 */
export function bindAiInstructionFilesystem(filesystem: FilesystemExecutor | undefined): void {
  boundFilesystem = filesystem;
}

function createDefaultAiInstructionRuntime(): PersistentAgentTurnRuntime {
  if (boundFilesystem === undefined) {
    throw AppError.notConfigured("The AI tool filesystem executor");
  }
  const stack = composeDefaultProviderStack();
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  return createPersistentTurnRuntime({
    stack,
    tools: [...readToolDefinitions, ...writeToolDefinitions],
    registry,
    filesystem: boundFilesystem,
    maxToolRounds: MAX_TOOL_ROUNDS,
  });
}

function resolveAiInstructionRuntime(): PersistentAgentTurnRuntime {
  if (boundRuntime !== undefined) return boundRuntime;
  let runtime: PersistentAgentTurnRuntime;
  try {
    runtime = createDefaultAiInstructionRuntime();
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Provider composition failure (e.g. no credentials configured) surfaces
    // as a safe, generic "not configured" rather than a raw config error.
    throw AppError.notConfigured("The AI provider");
  }
  boundRuntime = runtime;
  return runtime;
}

/**
 * Production entry point used by the route: resolves the bound (or lazily
 * default) persistent runtime, then runs the instruction through it.
 */
export async function runAiInstruction(
  c: { get: (key: string) => unknown },
  raw: unknown,
): Promise<AiInstructionResponse> {
  return runAiInstructionWithRuntime(resolveAiInstructionRuntime(), c, raw);
}
