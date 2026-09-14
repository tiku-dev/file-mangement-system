/**
 * Provider-independent AI boundary (Phase 10.2).
 *
 * The smallest typed abstraction between the agent layer and ANY AI
 * provider. A provider implementation (a future adapter for OpenAI,
 * Gemini, Grok, Anthropic, OpenRouter, Ollama, ...) must satisfy the
 * `AgentProvider` interface:
 *
 *   - it RECEIVES a provider-agnostic request/context (`AgentProviderRequest`):
 *     the user's message plus plain tool metadata;
 *   - it RETURNS a provider-agnostic response (`AgentResponse`) containing
 *     text and/or tool-call intents in the EXACT Phase 10.1 `AgentToolCall`
 *     shape;
 *   - it reports failures through the typed `ProviderError` contract.
 *
 * Flow:
 *
 *   user message + tool metadata
 *   → provider.generate()                     (ANY provider; no coupling here)
 *   → AgentResponse { text?, toolCalls? }
 *   → routeAgentResponse / runAgentTurn        (agent layer — the ONLY callers)
 *   → runAgentRequest() → invokeTool()         (Phase 10.1 / 9.8 — authenticated)
 *   → dispatchTool (registry → policy → handler → executor)
 *
 * Design rules:
 *
 *   - PROVIDER-INDEPENDENT: no OpenAI/Gemini/Grok/Anthropic vocab, no API
 *     keys, no env vars, no network calls in this module. Providers are
 *     swapped behind the same interface.
 *   - TOOLS ARE NEVER EXECUTED BY THE PROVIDER: the boundary only returns
 *     intents. Execution belongs exclusively to the agent layer via
 *     `runAgentRequest()` / `invokeTool()` — policy and registry are never
 *     bypassed.
 *   - PROVIDER OUTPUT IS NOT TRUSTED: intents returned by `generate()` are
 *     re-validated through `parseAgentRequest` before they are routed.
 */
import type { ToolDefinition } from "../tools/types.js";
import { AppError } from "../core/errors.js";
import type { AgentToolCall, AgentToolResult } from "./agent.js";
import { parseAgentRequest, runAgentRequest } from "./agent.js";
import type { InvokeToolOptions, ToolApprovalRequestInfo } from "./tools.js";

/**
 * The provider-agnostic context a provider receives to produce a reply.
 *
 * `tools` is plain metadata (name / description / input schema) — it does
 * NOT grant the provider any execution capability. The provider can only
 * name tools in its response; the agent layer decides whether to run them.
 */
export interface AgentProviderRequest {
  /** The user's goal / prompt. */
  message: string;
  /** Provider-agnostic metadata for the tools the agent may call. */
  tools: readonly ToolDefinition[];
  /**
   * Structured results of tool calls executed in previous rounds of a
   * bounded tool loop, in execution order. Present from the second
   * provider turn onward; omitted on the first turn. Used only as
   * context — the provider has no execution capability of its own.
   */
  toolResults?: AgentToolResult[];
}

/**
 * A provider-independent response. A provider returns free-form `text`
 * and/or `toolCalls`. Both fields are optional; a text-only turn needs
 * no tool execution and a tool-only turn produces no prose.
 */
export interface AgentResponse {
  /** Free-form textual reply. Optional when tool calls are returned. */
  text?: string;
  /**
   * Tool-call intents in the Phase 10.1 `AgentToolCall` shape. These are
   * routed by the agent layer — never executed by the provider.
   */
  toolCalls?: AgentToolCall[];
}

/**
 * The typed abstraction every AI provider adapter must implement.
 *
 * Implementations may call whatever external provider they wrap, but the
 * interface itself stays provider-agnostic: request and response carry no
 * provider-specific vocabulary, and failures are reported as `ProviderError`.
 */
export interface AgentProvider {
  generate(request: AgentProviderRequest): Promise<AgentResponse>;
}

/**
 * Stable, machine-readable codes for provider failures. Grouped so a
 * caller can branch without parsing messages. Retryability is carried
 * separately on each `ProviderError` instance.
 */
export const ProviderErrorCode = {
  /** Credentials / authorization rejected by the provider. Not retryable. */
  Authentication: "provider/authentication-failed",
  /** Provider rate-limited us. Transient — retry with backoff. */
  RateLimited: "provider/rate-limited",
  /** Provider did not answer in time. Transient — retry. */
  Timeout: "provider/timeout",
  /** Provider is unavailable / down. Transient — retry. */
  Unavailable: "provider/unavailable",
  /** The provider returned something the adapter could not parse/use. */
  InvalidResponse: "provider/invalid-response",
  /** Any other provider-side failure. */
  Internal: "provider/internal",
} as const;

export type ProviderErrorCode = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode];

/**
 * The typed error contract for provider failures.
 *
 * Distinct from `ToolError` (Phase 9.4, tool execution failures) and from
 * `AppError` (HTTP envelope): this type is what a provider adapter throws
 * when the OUTSIDE provider cannot be reached or misbehaves.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /**
   * True when a simple retry (with backoff) may succeed: transient
   * failures such as timeouts, rate limits, or unavailability. False for
   * permanent failures such as invalid credentials or malformed output.
   */
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }

  /** Convenience for transient, retryable failures. */
  static transient(code: ProviderErrorCode, message: string): ProviderError {
    return new ProviderError(code, message, true);
  }

  /** Convenience for permanent, non-retryable failures. */
  static permanent(code: ProviderErrorCode, message: string): ProviderError {
    return new ProviderError(code, message, false);
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** A single agent turn: the user's goal plus the tools the agent may use. */
export interface AgentTurn {
  /** The user's goal / prompt. */
  message: string;
  /** Plain tool metadata available to the provider for tool selection. */
  tools: readonly ToolDefinition[];
}

/**
 * The result of one agent turn: the provider's text (if any) plus the
 * routed per-intent execution results (if any).
 */
export interface AgentTurnOutput {
  /** Textual reply from the provider, when one was returned. */
  text?: string;
  /** Per-intent results of any tool calls the provider requested. */
  results: AgentToolResult[];
}

/**
 * The structured return from `routeAgentResponse`: per-intent execution
 * results plus any pending approval metadata collected during the round.
 * Pending approvals are extracted from `approval_required` outcomes so
 * callers can surface them to the authenticated client without coupling
 * to the internal error shape.
 */
export interface RouteAgentResponseResult {
  /** Per-intent execution results, in request order. */
  readonly results: AgentToolResult[];
  /**
   * Pending approval metadata collected from any `approval_required` results
   * in this round. Empty when no tools required approval.
   */
  readonly pendingApprovals: readonly ToolApprovalRequestInfo[];
}

/**
 * Validate a provider response's tool-call intents and route them through
 * the authenticated pipeline (`runAgentRequest()` → `invokeTool()`).
 *
 * This is the routing half of `runAgentTurn()`, split out so the bounded
 * agent loop (Phase 10.4) can reuse the exact same authenticated,
 * policy-gated execution path on every round.
 *
 * - Executes nothing from inside the provider.
 * - Re-validates provider output through `parseAgentRequest`.
 * - Returns an empty results array when the response requested no tools.
 * - Collects pending approval metadata from `approval_required` results
 *   (Phase 10.29) so callers can surface them to the authenticated client.
 *
 * @throws `AppError.badRequest` when the provider returned malformed intents.
 * @throws `AppError.unauthorized()` when `c` has no session identity.
 */
export async function routeAgentResponse(
  c: { get: (key: string) => unknown },
  response: AgentResponse,
  options: InvokeToolOptions,
): Promise<RouteAgentResponseResult> {
  if (!response.toolCalls || response.toolCalls.length === 0) {
    return { results: [], pendingApprovals: [] };
  }
  const request = parseAgentRequest({ calls: response.toolCalls });
  const agentResult = await runAgentRequest(c, request, options);
  return {
    results: agentResult.results,
    pendingApprovals: agentResult.pendingApprovals,
  };
}

/**
 * Run one agent turn: ask the provider for a reply, then route any
 * tool-call intents it returned through the authenticated pipeline.
 *
 * - Executes NOTHING from inside the provider. Tool execution happens
 *   here, in the agent layer, only via `runAgentRequest()` → `invokeTool()`.
 * - Provider output is re-validated through `parseAgentRequest` before
 *   routing: malformed intents are rejected rather than trusted.
 * - Identity comes from the authenticated session (`c`), never from the
 *   provider. Unauthenticated turns throw `AppError.unauthorized()`.
 *
 * @throws `ProviderError` when `generate()` fails with one (propagated).
 * @throws `AppError.badRequest` when the provider returned malformed intents.
 * @throws `AppError.unauthorized()` when `c` has no session identity.
 */
export async function runAgentTurn(
  c: { get: (key: string) => unknown },
  provider: AgentProvider,
  turn: AgentTurn,
  options: InvokeToolOptions,
): Promise<AgentTurnOutput> {
  const response = await provider.generate({
    message: turn.message,
    tools: turn.tools,
  });

  const { results } = await routeAgentResponse(c, response, options);
  return { text: response.text, results };
}
