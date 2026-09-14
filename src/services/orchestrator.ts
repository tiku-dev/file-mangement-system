/**
 * Agent turn orchestration (Phase 10.3).
 *
 * The application-level entry point for ONE agent turn: a user
 * instruction plus the authenticated session context. It:
 *
 *   1. Establishes the authenticated `ToolExecutionContext` from the
 *      session FIRST — fail-closed: no provider call without a valid
 *      session, even when the turn needs no tools.
 *   2. Sends the instruction + available tool metadata to the existing
 *      `AgentProvider` (Phase 10.2 boundary).
 *   3. Routes any returned tool-call intents through the existing
 *      `runAgentTurn()` → `runAgentRequest()` → `invokeTool()` pipeline.
 *   4. Returns the final text plus structured tool results.
 *
 * Every step preserves authentication, provider-output validation, and
 * the Phase 9 policy / registry gates. No AI provider is integrated
 * here — the provider is injected. No writes, no destructive tools, no
 * autonomous loops or retries.
 */
import { createSessionExecutionContext } from "../tools/sessionContext.js";
import type { ToolDefinition } from "../tools/types.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { InvokeToolOptions } from "./tools.js";
import {
  runAgentTurn,
  type AgentProvider,
  type AgentTurnOutput,
} from "./provider.js";

/**
 * Everything one orchestrated turn needs. Extends `InvokeToolOptions`
 * (the Phase 9.8 invocation dependencies) with the provider and the tool
 * metadata offered to it.
 */
export interface OrchestratedTurnOptions extends InvokeToolOptions {
  /** The provider adapter that produces the turn's reply / intents. */
  provider: AgentProvider;
  /** Plain tool metadata sent to the provider for tool selection. */
  tools: readonly ToolDefinition[];
}

/**
 * Run one agent turn for an authenticated session.
 *
 * - Identity comes from `c` (a request context that has been through
 *   `requireAuth`). The authenticated `ToolExecutionContext` is
 *   established up front, so an unauthenticated or disabled session is
 *   rejected BEFORE the provider is contacted — text-only turns are
 *   authorized too, not just tool-calling turns.
 * - The provider only ever returns intents; execution stays in the agent
 *   layer via `runAgentTurn` → `runAgentRequest` → `invokeTool`. Policy,
 *   registry, and permission gates are never bypassed.
 *
 * @param c — authenticated session context (established by the session layer).
 * @param instruction — the user's instruction / goal.
 * @param options — provider + invocation dependencies.
 *
 * @throws `AppError.unauthorized()` when `c` has no valid session.
 * @throws `ProviderError` when the provider fails (propagated, typed).
 * @throws `AppError.badRequest` when the provider returned malformed intents.
 */
export async function orchestrateTurn(
  c: { get: (key: string) => unknown },
  instruction: string,
  options: OrchestratedTurnOptions,
): Promise<AgentTurnOutput> {
  // Fail closed before spending a provider call: without a valid
  // authenticated ToolExecutionContext, even a text-only turn is rejected.
  createSessionExecutionContext(c);

  return runAgentTurn(
    c,
    options.provider,
    { message: instruction, tools: options.tools },
    options,
  );
}