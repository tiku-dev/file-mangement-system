/**
 * Structured agent context (Phase 10.5).
 *
 * The smallest typed model for EVERYTHING the provider receives during an
 * agent turn or bounded loop:
 *
 *   - the authenticated user's instruction
 *   - the tool definitions the agent is allowed to consider
 *   - prior tool results from the current loop
 *   - the auth context already supported by the existing agent contracts
 *
 * Design rules:
 *
 *   - PROVIDER-INDEPENDENT: the context carries zero provider vocabulary
 *     and zero AI coupling — just message + tool metadata + tool results.
 *   - IDENTITY/SEPARATION: user identity and policy are kept SEPARATE from
 *     the provider-controlled payload. `AgentContext` is the provider-visible
 *     surface; `AgentAuthContext` is derived and never handed to the
 *     provider. The authenticated user is used ONLY to pre-flight the turn
 *     (fail closed), never as data the provider can act on.
 *   - AVAILABILITY: context construction filters the candidate tool metadata
 *     down to tools that are actually REGISTERED (available) in the existing
 *     Tool Registry. Unknown/unregistered candidates are dropped.
 *   - NO PERMISSION GRANT: building context establishes the authenticated
 *     `ToolExecutionContext` (the same pre-flight `invokeTool`/`runAgentRequest`
 *     rely on) but grants nothing itself. Registration, policy, and
 *     `invokeTool()` remain the only gates on execution.
 *
 * This module is purely constructive/declarative: it calls no provider,
 * executes no tools, and never bypasses `invokeTool()` or the policy.
 */
import type { ToolDefinition } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createSessionExecutionContext } from "../tools/sessionContext.js";
import type { AgentToolResult } from "./agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A minimal, neutral representation of the authenticated user. Carried
 * only inside the security/identity channel — it is provided to context
 * construction for pre-flight authorization and is NOT exposed to the
 * provider as part of the provider-controlled context.
 */
export interface AgentUserIdentity {
  readonly id: string;
  readonly email?: string;
  readonly displayName?: string;
}

/**
 * The security/identity context of a turn. Kept strictly separate from
 * `AgentContext` (what the provider sees). It is created by pre-flight
 * authorization and is never serialized to the provider.
 */
export interface AgentAuthContext {
  /** The authenticated user, when the session is valid. */
  readonly user: AgentUserIdentity;
}

/**
 * Provider-controlled context: the smallest typed payload handed to the
 * provider. It contains ONLY data the provider may act on — the user's
 * instruction, the tools it may consider, and the prior loop results.
 * It deliberately contains no user identity, no policy grant, and no
 * registry handle: construction alone grants nothing.
 */
export interface AgentContext {
  /** The authenticated user's instruction / goal. */
  readonly instruction: string;
  /**
   * Metadata for the tools the agent is allowed to consider — restricted
   * to tools that are actually registered/available in the Tool Registry.
   */
  readonly tools: readonly ToolDefinition[];
  /**
   * Structured results of tool calls executed earlier in the current loop,
   * in execution order. Omitted when there are none.
   */
  readonly toolResults?: readonly AgentToolResult[];
}

/** Everything required to construct an `AgentContext` + `AgentAuthContext`. */
export interface AgentContextInput {
  /** The authenticated user's instruction / goal. */
  instruction: string;
  /**
   * Candidate tool metadata. Construction filters this down to only the
   * tools registered/available in `registry`.
   */
  tools: readonly ToolDefinition[];
  /** The Tool Registry — the source of truth for "available". */
  registry: ToolRegistry;
  /** Prior tool results from the current loop, if any. */
  toolResults?: readonly AgentToolResult[];
  /** The authenticated session's user, used for fail-closed pre-flight. */
  user?: unknown;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** A single immutable input-entry normalizer for `instruction`. */
function requirementString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `${name} must be a non-empty string, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Build the structured agent context for a turn.
 *
 * 1. PRE-FLIGHTS AUTH: establishes the authenticated `ToolExecutionContext`
 *    from the session (the same fail-closed gate `invokeTool` uses). An
 *    absent/invalid user throws `AppError.unauthorized()` — no context is
 *    produced, and no provider is contacted.
 * 2. FILTERS TOOLS: keeps only candidate tool definitions whose names are
 *    registered/available in the Tool Registry.
 * 3. RETURNS the provider-visible `AgentContext` (instruction + filtered
 *    tools + prior results) and the separate `AgentAuthContext`.
 *
 * Constructing context grants no permissions and executes nothing; the
 * returned `tools` are metadata only, and execution still requires
 * `invokeTool()`/policy on every actual call.
 *
 * @throws `AppError.unauthorized()` when `user` is absent/invalid.
 * @throws `TypeError` when `instruction` is not a non-empty string.
 */
export function buildAgentContext(input: AgentContextInput): {
  context: AgentContext;
  auth: AgentAuthContext;
} {
  // Fail closed: an authenticated ToolExecutionContext is required even to
  // build context. This never grants anything — it only proves identity.
  const session = createSessionExecutionContext({
    get: (k) => (k === "user" ? input.user : undefined),
  });

  const instruction = requirementString("instruction", input.instruction);

  // Only expose tools that are actually registered/available.
  const available = input.tools.filter((tool) => input.registry.has(tool.name));

  const context: AgentContext = {
    instruction,
    tools: available,
    ...(input.toolResults && input.toolResults.length > 0
      ? { toolResults: [...input.toolResults] }
      : {}),
  };

  const identity =
    session.actor.kind === "ai-agent" ? session.actor.identity : undefined;

  const auth: AgentAuthContext = {
    user: {
      id: identity?.userId ?? "",
      ...(identity && identity.email !== undefined
        ? { email: identity.email }
        : {}),
      ...(identity && identity.displayName !== undefined
        ? { displayName: identity.displayName }
        : {}),
    },
  };

  return { context, auth };
}
