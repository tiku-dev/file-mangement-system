/**
 * Tool invocation service (Phase 9.8).
 *
 * The application/API entry point for invoking a registered tool. Given
 * an authenticated request (a Hono context that has been through
 * `requireAuth`), a tool name, and the untrusted input, it:
 *
 *   1. Obtains the identity from the authenticated session.
 *   2. Creates the `ToolExecutionContext`.
 *   3. Dispatches through the existing Tool Registry + policy pipeline.
 *   4. Returns the existing structured `ToolExecutionResult` / `ToolError`.
 *
 * Flow:
 *
 *   Authenticated request
 *   → createSessionExecutionContext(c)   (Phase 9.7)
 *   → Tool Registry check                (Phase 9.1)
 *   → APPROVAL GATE (Phase 10.28C)       (gated tools: create pending /
 *                                         execute stored args — never both)
 *   → dispatchTool(registry, name, input, { filesystem }, context)
 *   → policy → handler → executor
 *
 * Trust model: the identity is read from the session established by
 * `requireAuth` (via `createSessionExecutionContext`). The `input` is
 * untrusted and never influences identity; request-supplied identity
 * fields are ignored.
 *
 * No AI/LLM/provider, no new tools, no write/destructive operations,
 * and no new auth/context/policy system. The registry and
 * FilesystemExecutor are injected so the service is testable without
 * Tauri and so any future executor wiring can be substituted here.
 */
import { createSessionExecutionContext } from "../tools/sessionContext.js";
import {
  dispatchTool,
  runToolPreflight,
} from "../tools/handlers/index.js";
import { isToolRegistryError, type ToolRegistry } from "../tools/registry.js";
import { requiresToolApproval, type ToolDefinition } from "../tools/types.js";
import { ToolError, ToolErrorCode } from "../tools/errors.js";
import type {
  FilesystemExecutor,
} from "../tools/executor.js";
import type {
  RawToolInput,
  ToolExecutionResult,
  ToolFailureResult,
} from "../tools/handlers/handler.js";
import type { ToolExecutionContext, ToolPolicy } from "../tools/policy.js";
import {
  ToolApprovalDuplicateError,
  ToolApprovalInvalidArgumentsError,
  ToolApprovalValidationError,
  assertToolApprovalExecutable,
  createAiToolApproval,
  getPendingToolApproval,
  getToolApproval,
} from "./aiToolApprovals.js";

/** Dependencies the invocation service needs to run pipeline stages. */
export interface InvokeToolOptions {
  /** The injected Tool Registry (Phase 9.1). Never bypassed. */
  registry: ToolRegistry;
  /** The injected FilesystemExecutor — the bridge to Tauri/Rust. */
  filesystem: FilesystemExecutor;
  /**
   * Optional policy override, mirroring `dispatchTool`. Defaults to the
   * Phase 9.5 default policy.
   */
  policy?: ToolPolicy;
  /**
   * Optional persistent-turn provenance (Phase 10.28C-prep). A bounded
   * persistent turn eagerly commits its conversation and the round's
   * assistant/tool-call message BEFORE the round's intents execute, then
   * threads the two REAL persisted ids here so `invokeTool` can bind them
   * to the `ToolExecutionContext` at the invocation boundary. Absent for
   * direct / non-persistent invocations — behavior is unchanged.
   */
  turnContext?: AgentTurnContext;
  /**
   * Trusted approval-presentation channel (Phase 10.28C). When set for an
   * APPROVAL-GATED tool, the invocation executes ONLY the exact validated
   * arguments stored in this owned, `approved`, unexpired approval — the
   * caller-supplied `input` is never executed. When absent, a gated tool is
   * NEVER executed: a pending approval is created and an
   * `approval_required` result is returned. Never sourced from provider
   * output or from the untrusted tool input; ignored for tools that do not
   * declare `requiresApproval: true`.
   */
  approvalId?: string;
}

/**
 * The authenticated, PERSISTED conversation/message context a tool call
 * belongs to. Produced only by the persistent-turn layer from committed
 * repository rows — these ids are never supplied by provider output or
 * by the untrusted tool input.
 */
export interface AgentTurnContext {
  /** Persisted owning conversation id (UUID, repository-assigned). */
  conversationId: string;
  /** Persisted assistant/tool-call message id owning the current round. */
  messageId: string;
}

// ---------------------------------------------------------------------------
// Approval gate (Phase 10.28C)
// ---------------------------------------------------------------------------

/** How long a freshly created pending approval stays decidable. */
export const TOOL_APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Safe, typed information about the pending approval a gated invocation
 * produced. Deliberately narrow: the approval id (so the caller / user can
 * reference it), the tool name, the VALIDATED arguments that were stored,
 * and the expiry of the approval window. No execution has happened.
 */
export interface ToolApprovalRequestInfo {
  /** The persisted pending approval id. */
  readonly approvalId: string;
  /** The registered tool the approval was created for. */
  readonly toolName: string;
  /** The schema-validated arguments stored in the approval. */
  readonly arguments: unknown;
  /** When the approval window closes. */
  readonly expiresAt: Date;
}

/**
 * The typed `approval_required` result: a structured failure (category
 * `security`, code `tools/approval-required`) enriched with the pending
 * approval's safe information. The gated tool was NOT executed.
 */
export interface ToolApprovalRequiredResult extends ToolFailureResult {
  /** Discriminator, always `true` on an approval_required result. */
  readonly approvalRequired: true;
  /** The pending approval's safe information. */
  readonly approval: ToolApprovalRequestInfo;
}

/** Narrow a tool execution result to an `approval_required` result. */
export function isToolApprovalRequiredResult(
  result: ToolExecutionResult,
): result is ToolApprovalRequiredResult {
  return (
    !result.ok &&
    "approvalRequired" in result &&
    result.approvalRequired === true &&
    "approval" in result
  );
}

/**
 * Invoke a registered tool for the authenticated session user.
 *
 * Security chain (Phase 10.28C): authentication → registry → APPROVAL →
 * policy → handler → executor. The approval stage sits between the registry
 * and the policy, inside this service — `dispatchTool` stays approval-agnostic.
 *
 * - Throws `AppError.unauthorized()` when no session identity is present.
 * - A tool with `requiresApproval: true` is NEVER executed directly:
 *   - without `options.approvalId` a PENDING approval is created (requires
 *     the persisted turn context) and a typed `approval_required` result is
 *     returned — the handler and executor are never reached;
 *   - with `options.approvalId` the gate loads the approval owned by the
 *     authenticated user, requires the exact tool name and an `approved`,
 *     unexpired state, and executes ONLY the stored validated arguments —
 *     still through the unchanged policy → handler → executor pipeline.
 * - Every other outcome is returned as a structured `ToolExecutionResult`.
 */
export async function invokeTool(
  c: { get: (key: string) => unknown },
  toolName: string,
  input: RawToolInput,
  options: InvokeToolOptions,
): Promise<ToolExecutionResult> {
  const executionContext = createSessionExecutionContext(c, options.turnContext);

  // Gate 1 — REGISTRY. Mirrors dispatchTool's first gate so the approval
  // decision below is made only for REGISTERED tools; an unknown tool
  // produces the identical structured error it always has.
  let definition: ToolDefinition;
  try {
    definition = options.registry.get(toolName);
  } catch (error) {
    if (isToolRegistryError(error)) {
      return {
        ok: false,
        error: new ToolError(
          "unknown_tool",
          error.code,
          `The requested tool "${toolName}" is not available.`,
        ),
      };
    }
    return { ok: false, error: ToolError.internal() };
  }

  // Gate 2 — APPROVAL. A gated tool never reaches policy/handler/executor
  // without an executable approval; ungated tools are unchanged.
  if (requiresToolApproval(definition)) {
    return runApprovalGate(executionContext, toolName, input, options);
  }

  // Gates 3+ — policy → handler → executor, exactly as before.
  return dispatchTool(
    options.registry,
    toolName,
    input,
    { filesystem: options.filesystem },
    executionContext,
    options.policy,
  );
/**
 * The Phase 10.28C approval stage. Two strictly separated paths:
 *
 *   - EXECUTE (an approval was explicitly presented): load the OWNED record,
 *     require the exact tool name and an `approved`, unexpired state, then
 *     dispatch the approval's STORED arguments. The caller-supplied input is
 *     ignored — arguments, tool name, conversation, message, and identity
 *     cannot be altered by the caller.
 *   - CREATE (no approval presented): record a PENDING approval bound to the
 *     authenticated user and the persisted turn context, and return
 *     `approval_required`. The tool is not executed.
 *
 * Every rejection is a structured `security` result; nothing is executed.
 */
async function runApprovalGate(
  executionContext: ToolExecutionContext,
  toolName: string,
  input: RawToolInput,
  options: InvokeToolOptions,
): Promise<ToolExecutionResult> {
  const identity =
    executionContext.actor.kind === "ai-agent"
      ? executionContext.actor.identity
      : undefined;
  const userId = identity?.userId;
  if (userId === undefined || userId.length === 0) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.IdentityMissing,
        "Tool execution requires an authenticated identity.",
      ),
    };
  }

  // ---- EXECUTE path: an explicitly presented approval -----------------------
  if (options.approvalId !== undefined) {
    const record = await getToolApproval(userId, options.approvalId);
    if (record === null) {
      // Missing or foreign — deliberately indistinguishable.
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.ApprovalNotFound,
          "Tool approval not found for this user.",
        ),
      };
    }
    if (record.toolName !== toolName) {
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.ApprovalToolMismatch,
          `This tool approval was not created for tool "${toolName}".`,
        ),
      };
    }
    try {
      // The real Phase 10.28B guard: only `approved` AND inside the window.
      assertToolApprovalExecutable(record, new Date());
    } catch (error) {
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.ApprovalNotExecutable,
          error instanceof Error
            ? error.message
            : "This tool approval cannot be executed.",
        ),
      };
    }
    // Execute the EXACT stored, validated arguments — never the caller's
    // input — through the unchanged policy → handler → executor pipeline.
    return dispatchTool(
      options.registry,
      toolName,
      record.arguments as RawToolInput,
      { filesystem: options.filesystem },
      executionContext,
      options.policy,
    );
  }

  // ---- CREATE path: record a pending approval, execute nothing --------------
  if (options.turnContext === undefined) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.ApprovalContextMissing,
        `Tool "${toolName}" requires approval, which needs a persisted conversation and message context.`,
      ),
    };
  }
  // Phase 10.36: run the tool's read-only PREFLIGHT BEFORE any approval record
  // exists. A preflight performs DEEP validation that the generic schema check
  // cannot express (source exists + is a file, destination parent is a folder,
  // destination is free, both paths stay within permitted scope). Failing here
  // means NO approval is created and NOTHING executes — an approval can never
  // encode arguments that are provably invalid or unsafe at creation time.
  const preflightError = await runToolPreflight(
    toolName,
    input,
    options.filesystem,
  );
  if (preflightError !== null) {
    return { ok: false, error: preflightError };
  }
  const now = new Date();
  try {
    const record = await createAiToolApproval(
      {
        userId,
        conversationId: options.turnContext.conversationId,
        messageId: options.turnContext.messageId,
        toolName,
        arguments: input,
        expiresAt: new Date(now.getTime() + TOOL_APPROVAL_WINDOW_MS),
        now,
      },
      { registry: options.registry },
    );
    return approvalRequiredResult(record);
  } catch (error) {
    if (error instanceof ToolApprovalInvalidArgumentsError) {
      return {
        ok: false,
        error: ToolError.validation(ToolErrorCode.ApprovalInvalidArguments, error.message),
      };
    }
    if (error instanceof ToolApprovalDuplicateError) {
      // Idempotent re-request: surface the EXISTING pending approval for the
      // same message + tool instead of writing a second row.
      const existing = await getPendingToolApproval(
        userId,
        options.turnContext.messageId,
        toolName,
      );
      if (existing !== null) {
        return approvalRequiredResult(existing);
      }
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.ApprovalRequired,
          `A pending approval already exists for tool "${toolName}" in this message.`,
        ),
      };
    }
    if (error instanceof ToolApprovalValidationError) {
      // Malformed turn-context ids or expiry — fail closed, execute nothing.
      return {
        ok: false,
        error: ToolError.security(ToolErrorCode.ApprovalContextMissing, error.message),
      };
    }
    // UnknownTool / NotRequired cannot occur (the registry was pre-checked),
    // and any other failure (e.g. a foreign conversation id violating the FK)
    // is fail-closed: execute nothing.
    return { ok: false, error: ToolError.internal() };
  }
}

/** Build the typed `approval_required` result for a pending record. */
function approvalRequiredResult(record: {
  id: string;
  toolName: string;
  arguments: unknown;
  expiresAt: Date;
}): ToolApprovalRequiredResult {
  return {
    ok: false,
    error: ToolError.security(
      ToolErrorCode.ApprovalRequired,
      `Tool "${record.toolName}" requires user approval; approval ${record.id} is pending and the tool was not executed.`,
    ),
    approvalRequired: true,
    approval: {
      approvalId: record.id,
      toolName: record.toolName,
      arguments: record.arguments,
      expiresAt: record.expiresAt,
    },
  };
}
}