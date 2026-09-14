/**
 * AI agent orchestration contract (Phase 10.1).
 *
 * The smallest foundation for an AI agent to produce tool-call intents
 * and route them through the EXISTING authenticated invocation pipeline
 * (`invokeTool`, Phase 9.8):
 *
 *   Agent request (typed contract)
 *   → parseAgentRequest          (runtime validation, provider-agnostic)
 *   → runAgentRequest            (per-intent orchestration)
 *   → invokeTool(c, ...)          (Phase 9.8 — authenticated session)
 *   → dispatchTool                (registry → policy → handler → executor)
 *
 * Design rules:
 *
 *   - PROVIDER-INDEPENDENT: the tool-call intent shape (`AgentToolCall`)
 *     uses neutral field names (`toolName`, `input`) — no LLM, provider,
 *     function-call, or API-key vocabulary. Any provider can produce it.
 *   - NO identity of its own: the caller's authenticated session (the
 *     Hono context that has been through `requireAuth`) is the single
 *     source of truth for identity. Intents cannot carry or override it.
 *   - POLICY PRESERVED: every intent is dispatched through the same
 *     registry + policy pipeline as any direct invocation. Nothing here
 *     bypasses permissions or the Tool Registry.
 *   - No AI provider, no LLM calls, no API keys, no new tools, no new
 *     filesystem access.
 */
import { AppError } from "../core/errors.js";
import type { RawToolInput } from "../tools/handlers/handler.js";
import type { ToolError } from "../tools/errors.js";
import {
  invokeTool,
  isToolApprovalRequiredResult,
  type InvokeToolOptions,
  type ToolApprovalRequestInfo,
} from "./tools.js";

/**
 * A provider-independent representation of an agent tool-call intent.
 *
 * This is the ONLY surface through which a future agent may ask for a
 * tool to be run. It carries the caller-correlation id, the registered
 * tool name, and the untrusted input bag — never identity.
 */
export interface AgentToolCall {
  /** Caller-supplied id so the result can be correlated back. */
  id: string;
  /** Name of a REGISTERED tool (validated by the Tool Registry at dispatch). */
  toolName: string;
  /** Untrusted input bag. Type-checked by the tool's handler, not here. */
  input: RawToolInput;
}

/**
 * A typed agent request: one or more tool-call intents to execute in
 * order. The `id` is an optional opaque correlation reference.
 */
export interface AgentRequest {
  /** Opaque caller reference for correlation / auditing. Optional. */
  id?: string;
  /** Tool-call intents, executed in array order. */
  calls: AgentToolCall[];
}

/**
 * The structured result of a single agent tool call. Mirrors the Phase
 * 9.4 `ToolExecutionResult` contract and adds the `callId` correlation.
 */
export type AgentToolResult<T = unknown> =
  | { ok: true; callId: string; data: T }
  | { ok: false; callId: string; error: ToolError };

/** Typed result contract for an agent request. */
export interface AgentResult<T = unknown> {
  /** Echoes the request `id` when one was supplied. */
  requestId?: string;
  /** Per-intent results, in request order. */
  results: AgentToolResult<T>[];
  /**
   * Pending approval metadata collected from any `approval_required` results
   * (Phase 10.29). Empty when no gated tool required approval. Safe metadata
   * only: approval id, tool name, validated arguments, and expiry.
   */
  pendingApprovals: readonly ToolApprovalRequestInfo[];
}

/**
 * Validate an untrusted runtime value into the typed `AgentRequest`
 * contract. Rejects any malformed shape with `AppError.badRequest`.
 *
 * Parsing is the ONLY gate on request shape; identity is never read
 * here (it comes from the authenticated session via `invokeTool`).
 */
export function parseAgentRequest(value: unknown): AgentRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw AppError.badRequest("Agent request must be a JSON object.");
  }
  const record = value as Record<string, unknown>;

  let id: string | undefined;
  if (record.id !== undefined) {
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw AppError.badRequest("Agent request id must be a non-empty string.");
    }
    id = record.id;
  }

  if (!Array.isArray(record.calls)) {
    throw AppError.badRequest("Agent request must include a calls array.");
  }

  const calls: AgentToolCall[] = record.calls.map(parseAgentToolCall);
  return { id, calls };
}

/** Validate a single untrusted tool-call intent into `AgentToolCall`. */
function parseAgentToolCall(value: unknown): AgentToolCall {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw AppError.badRequest("Agent tool call must be a JSON object.");
  }
  const record = value as Record<string, unknown>;

  if (typeof record.id !== "string" || record.id.length === 0) {
    throw AppError.badRequest("Agent tool call id must be a non-empty string.");
  }
  if (typeof record.toolName !== "string" || record.toolName.length === 0) {
    throw AppError.badRequest("Agent tool call toolName must be a non-empty string.");
  }
  if (typeof record.input !== "object" || record.input === null || Array.isArray(record.input)) {
    throw AppError.badRequest("Agent tool call input must be a JSON object.");
  }

  return {
    id: record.id,
    toolName: record.toolName,
    input: record.input as RawToolInput,
  };
}

/**
 * Execute an agent request by routing each tool-call intent through the
 * EXISTING authenticated invocation path (`invokeTool`).
 *
 * - Identity comes from the authenticated session (`c`), not the request.
 * - Intents run in order; a failing intent does not abort the rest —
 *   each one returns its own structured result.
 * - Policy, registry, and permissions are the same ones direct invocations
 *   use. Nothing is bypassed.
 *
 * Throws `AppError.unauthorized()` when `c` has no session identity.
 */
export async function runAgentRequest(
  c: { get: (key: string) => unknown },
  request: AgentRequest,
  options: InvokeToolOptions,
): Promise<AgentResult> {
  const results: AgentToolResult[] = [];
  const pendingApprovals: ToolApprovalRequestInfo[] = [];
  for (const call of request.calls) {
    const result = await invokeTool(c, call.toolName, call.input, options);
    // Phase 10.29: surface the pending approval's safe metadata alongside the
    // structured denial, so the instruction flow can report it to the client.
    if (isToolApprovalRequiredResult(result)) {
      pendingApprovals.push(result.approval);
    }
    results.push(
      result.ok
        ? { ok: true, callId: call.id, data: result.data }
        : { ok: false, callId: call.id, error: result.error },
    );
  }
  return { requestId: request.id, results, pendingApprovals };
}
