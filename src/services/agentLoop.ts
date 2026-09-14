/**
 * Bounded agent tool loop (Phase 10.4).
 *
 * Extends the single agent turn into a loop: a provider may request tools,
 * receive their structured results, and make another provider turn — until
 * the provider returns final text OR a strict configurable maximum number
 * of tool rounds is reached.
 *
 * Flow (per round):
 *
 *   provider.generate({ message, tools, toolResults? })   (ANY provider)
 *   → AgentResponse { text?, toolCalls? }
 *   → toolCalls? → routeAgentResponse                     (Phase 10.2 routing)
 *   → runAgentRequest() → invokeTool()                    (Phase 10.1 / 9.8)
 *   → dispatchTool (registry → policy → handler → executor)
 *   → result fed BACK to the provider as `toolResults` context
 *
 * Reuses the existing Phase 10.2 routing + Phase 10.1 request pipeline on
 * EVERY round: authentication, input validation, and the tool policy are
 * enforced each round, exactly as in a single turn. Each round's structured
 * results are accumulated and handed to the provider as context for the
 * next round; the provider never gains execution capability.
 *
 * The loop is BOUNDED server-side: after each executed tool round the round
 * counter grows, and a provider that requests tools beyond `maxToolRounds`
 * is stopped with a typed `AgentLoopError` — those extra tools are never
 * executed.
 *
 * Design rules:
 *
 *   - NO autonomous/background execution, NO retries/backoff, NO loops that
 *     run past the configured maximum. One loop invocation runs synchronously
 *     and terminates on final text or the round limit.
 *   - NO provider/API-key/network code here — the loop only talks to the
 *     injected `AgentProvider` abstraction.
 *   - Tool execution NEVER bypasses `invokeTool()`: intents are validated
 *     via `parseAgentRequest` and routed through `routeAgentResponse`, the
 *     same authenticated, policy-gated path a single turn uses.
 */
import type { AgentToolCall, AgentToolResult } from "./agent.js";
import type { AgentProviderRequest, AgentResponse } from "./provider.js";
import { routeAgentResponse } from "./provider.js";
import type { OrchestratedTurnOptions } from "./orchestrator.js";
import type { AgentTurnContext } from "./tools.js";
import type { ToolApprovalRequestInfo } from "./tools.js";
import { createSessionExecutionContext } from "../tools/sessionContext.js";

/**
 * A clear, typed error raised when the provider keeps requesting tools
 * past the configured maximum number of tool rounds.
 */
export class AgentLoopError extends Error {
  static readonly code = "agent/max-tool-rounds-reached";

  /** The configured maximum number of tool rounds (a strict bound). */
  readonly maxToolRounds: number;
  /**
   * The `code` property mirrors the string constant above; provided so an
   * `AgentLoopError` instance can be matched by a stable machine-readable
   * code without importing the class.
   */
  readonly code: string;

  constructor(maxToolRounds: number) {
    super(`Agent requested tools after the maximum of ${maxToolRounds} tool round(s) was reached.`);
    this.name = "AgentLoopError";
    this.maxToolRounds = maxToolRounds;
    this.code = AgentLoopError.code;
  }
}

export function isAgentLoopError(error: unknown): error is AgentLoopError {
  return error instanceof AgentLoopError;
}

/** Configuration for `runAgentLoop`: turn options plus the round limit. */
export interface AgentLoopOptions extends OrchestratedTurnOptions {
  /**
   * Strict maximum number of tool-execution rounds. The loop executes tool
   * intents on at most this many rounds; a provider requesting tools once
   * more is stopped with `AgentLoopError`. Must be a positive integer.
   */
  maxToolRounds: number;
  /**
   * Optional observer invoked once after every EXECUTED tool round with the
   * provider's message for that round (text + intents), the round's
   * structured results, and the running round count. Additive and optional —
   * existing callers are unaffected when it is omitted. Lets persistence
   * record the transcript without re-implementing the loop.
   */
  /**
   * Observer invoked AFTER each executed tool round with its text,
   * tool-call intents, structured results, and the running round count.
   */
  onRound?: (round: AgentLoopRound) => void;
  /**
   * Optional async hook invoked BEFORE each tool-call round executes its
   * intents (Phase 10.28C-prep). The caller uses it to establish the
   * PERSISTED conversation/message context the round's tool executions
   * belong to: for a persistent turn it commits the round's
   * assistant/tool-call message and returns its real
   * `{ conversationId, messageId }`. That context is threaded through
   * `routeAgentResponse` → `invokeTool` and bound to every tool's
   * `ToolExecutionContext` in the round. When the hook returns
   * `undefined` — or is absent entirely — no turn context is threaded
   * (non-persistent loops are unchanged).
   */
  prepareRound?: (response: AgentResponse) => Promise<AgentTurnContext | undefined>;
  /**
   * Seeded structured results of an approval round that was ALREADY executed
   * before this loop ran (Phase 10.30). The loop starts with these as
   * context — the provider's first request already carries them — and the
   * running round count starts at `initialToolRounds`. Additive and optional;
   * omitted for every existing loop, which starts empty at round zero.
   */
  initialToolResults?: readonly AgentToolResult[];
  /**
   * Seeded running round count. The approved tool execution counts as one
   * round against `maxToolRounds`: when resuming an approval the caller
   * passes `1` so the conversation's bound is respected from the very
   * first provider request. Defaults to zero.
   */
  initialToolRounds?: number;
}

/** What one executed tool round looked like, for observers. */
export interface AgentLoopRound {
  /** The provider's free-form text for the round, when it produced any. */
  readonly text?: string;
  /** The tool-call intents that were executed this round. */
  readonly toolCalls: readonly AgentToolCall[];
  /** The structured results of executing those intents, in order. */
  readonly results: readonly AgentToolResult[];
  /** The running number of tool-execution rounds performed so far. */
  readonly toolRounds: number;
}

/** The result of a bounded agent tool loop. */
export interface AgentLoopOutput {
  /** The provider's final text, if the loop ended on a text-only turn. */
  text?: string;
  /** Structured tool results accumulated across all executed rounds. */
  results: AgentToolResult[];
  /** Number of tool-execution rounds actually performed. */
  toolRounds: number;
  /**
   * Pending approval metadata collected across all executed rounds
   * (Phase 10.29). Empty when no tools required approval.
   */
  pendingApprovals: readonly ToolApprovalRequestInfo[];
}

/**
 * Run a bounded agent tool loop for a user instruction.
 *
 * - Establishes the authenticated `ToolExecutionContext` up front, so
 *   unauthenticated sessions are rejected before the provider is contacted
 *   (fail-closed, including text-only loops).
 * - Calls `provider.generate(...)` with the instruction, tool metadata, and
 *   (from the second round onward) the structured results of every tool call
 *   executed so far.
 * - Routes each round's intents through `routeAgentResponse()` — the same
 *   authenticated, validated, policy-gated pipeline as a single turn.
 * - Terminates with `{ text, results, toolRounds }` when the provider
 *   returns final text (no tool calls), and throws `AgentLoopError` when the
 *   provider requests tools past `maxToolRounds`.
 * - May be SEEDED (Phase 10.30): `initialToolResults` are shown to the
 *   provider as already-executed context on the first request and
 *   `initialToolRounds` counts them against `maxToolRounds`, so a resumed
 *   approval execution is inside the bound, not outside it.
 *
 * @throws `AppError.unauthorized()` when `c` has no session identity.
 * @throws `AppError.badRequest` when the provider returns malformed intents
 *         on any round.
 * @throws `ProviderError` when `generate()` fails with one (propagated,
 *         no execution happens after the failed round).
 * @throws `AgentLoopError` when the provider requests tools past
 *         `maxToolRounds`; the extra tools are NOT executed.
 */
export async function runAgentLoop(
  c: { get: (key: string) => unknown },
  instruction: string,
  options: AgentLoopOptions,
): Promise<AgentLoopOutput> {
  if (!Number.isInteger(options.maxToolRounds) || options.maxToolRounds < 1) {
    throw new TypeError(`maxToolRounds must be a positive integer, got ${options.maxToolRounds}`);
  }
  if (
    options.initialToolRounds !== undefined &&
    (!Number.isInteger(options.initialToolRounds) || options.initialToolRounds < 0)
  ) {
    throw new TypeError(
      `initialToolRounds must be a non-negative integer, got ${options.initialToolRounds}`,
    );
  }

  createSessionExecutionContext(c);

  let toolResults: AgentToolResult[] = options.initialToolResults
    ? [...options.initialToolResults]
    : [];
  let toolRounds = options.initialToolRounds ?? 0;
  const pendingApprovals: ToolApprovalRequestInfo[] = [];

  while (true) {
    const request: AgentProviderRequest = {
      message: instruction,
      tools: options.tools,
      ...(toolResults.length > 0 ? { toolResults } : {}),
    };

    const response = await options.provider.generate(request);

    if (!response.toolCalls || response.toolCalls.length === 0) {
      return { text: response.text, results: toolResults, toolRounds, pendingApprovals };
    }

    if (toolRounds >= options.maxToolRounds) {
      throw new AgentLoopError(options.maxToolRounds);
    }

    toolRounds += 1;

    // Phase 10.28C-prep: before the round's intents execute, allow the
    // caller to establish the PERSISTED conversation/message context the
    // executions belong to. The returned ids are threaded through the
    // same `routeAgentResponse` → `invokeTool` pipeline as every other
    // option — nothing here bypasses policy or the authenticated path.
    let roundContext: AgentTurnContext | undefined;
    if (options.prepareRound !== undefined) {
      const prepared = await options.prepareRound(response);
      if (prepared !== undefined) roundContext = prepared;
    }
    const routed = await routeAgentResponse(c, response, {
      ...options,
      ...(roundContext !== undefined ? { turnContext: roundContext } : {}),
    });
    toolResults = [...toolResults, ...routed.results];
    pendingApprovals.push(...routed.pendingApprovals);
    options.onRound?.({
      text: response.text,
      toolCalls: response.toolCalls,
      results: routed.results,
      toolRounds,
    });
  }
}
