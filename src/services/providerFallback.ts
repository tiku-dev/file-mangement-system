/**
 * Provider fallback orchestration (Phase 10.13).
 *
 * A small, provider-independent layer that composes the Phase 10.10 provider
 * selection and Phase 10.11/10.12 credential pool into an `AgentProvider`.
 * The AGENT is completely unaware: it holds a normal `AgentProvider` facade
 * (`generate(request)` → `AgentResponse`). No provider id, no credential, no
 * fallback mechanics ever appear in agent contracts, responses, policy
 * decisions, or serialized state.
 *
 * Deterministic policy, in order, per `generate()` call:
 *
 *   1. Try each CONFIGURED provider in its configured order.
 *   2. Within a provider, start from its CURRENT credential (the pool's
 *      rotation state) and try credentials in the pool's round-robin order.
 *   3. On a failure the EXPLICIT classification policy (`classifyProviderFailure`)
 *      decides narrowly:
 *        - Authentication / RateLimited / Unavailable / Timeout  → rotate to
 *          the next credential for the SAME provider via `CredentialPool.rotate()`.
 *        - anything else (InvalidResponse, Internal, non-ProviderError, ...)
 *          → STOP immediately and rethrow the ORIGINAL error unchanged.
 *      The policy never retries blindly: malformed requests, invalid tool
 *      calls, validation errors, and unknown failures stop the run.
 *   4. After all of a provider's credentials are exhausted (or the provider
 *      has none), move to the next configured provider.
 *   5. When every configured provider / credential is unavailable, throw a
 *      typed `ProviderFallbackError` (still a `ProviderError`, so the agent
 *      layer keeps its normal typed-failure contract) listing each failed
 *      attempt as `{ provider, credentialId, code }` — never a secret value.
 *
 * Credential values stay OPAQUE end to end: this module only ever sees
 * `OpaqueCredential` handles (from `CredentialPool`), and the only code that
 * may reveal a value is the injected `build` function — the composition root
 * that constructs concrete adapters such as `createGrokProvider`. No secrets
 * enter this module's errors, logs, or results.
 *
 * No automatic background retries: rotation/fallback happens only inside the
 * current `generate()` call, only for policy-approved failures, and only on
 * explicit `rotate()`.
 */
import type { AgentProvider } from "./provider.js";
import type { AgentProviderRequest, AgentResponse } from "./provider.js";
import {
  isProviderError,
  ProviderError,
  ProviderErrorCode,
} from "./provider.js";
import type { OpaqueCredential } from "./credentialPool.js";
import type { ProviderHealth } from "./providerHealth.js";
import type { ProviderId as ProviderIdType } from "./providerSelection.js";

// `ProviderId` is the value-map name-space in providerSelection; here we only
// need the string-union TYPE, so alias the type import locally.
type ProviderId = ProviderIdType;

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------

/** What the orchestration should do with a provider failure. */
export type ProviderFailureAction = "rotate-credential" | "stop";

/**
 * The EXPLICIT, deterministic failure classification. Only failures that are
 * safely attributable to the current credential or to provider unavailability
 * ever justify rotating; everything else stops the run immediately.
 *
 *   rotate-credential: Authentication, RateLimited, Unavailable, Timeout
 *   stop:              InvalidResponse, Internal, non-ProviderError, ...
 */
export function classifyProviderFailure(error: unknown): ProviderFailureAction {
  if (isProviderError(error)) {
    switch (error.code) {
      case ProviderErrorCode.Authentication:
      case ProviderErrorCode.RateLimited:
      case ProviderErrorCode.Unavailable:
      case ProviderErrorCode.Timeout:
        return "rotate-credential";
      default:
        return "stop";
    }
  }
  return "stop";
}

// ---------------------------------------------------------------------------
// Orchestration inputs
// ---------------------------------------------------------------------------

/**
 * The credential-surface the orchestrator needs: exactly the pool's
 * selection/rotation methods, WITHOUT `reveal`. Passing the real
 * `CredentialPool` satisfies this interface structurally, and rotate() is
 * reused — no duplicated rotation state anywhere.
 */
export interface CredentialSelector {
  has(provider: ProviderId): boolean;
  obtain(provider: ProviderId): OpaqueCredential;
  rotate(provider: ProviderId): OpaqueCredential;
  all(provider: ProviderId): readonly OpaqueCredential[];
}

/**
 * Build a concrete `AgentProvider` for a provider given an OPAQUE credential
 * handle. This is the ONLY code that may reveal a credential — it is the
 * composition root (e.g. `pool.reveal(handle)` → `createGrokProvider(...)`).
 */
export type ProviderBuilder = (
  provider: ProviderId,
  credential: OpaqueCredential,
) => AgentProvider;

export interface ProviderFallbackOptions {
  /** Configured providers, tried in this exact, deterministic order. */
  providers: readonly ProviderId[];
  /** Credential source + rotation (a `CredentialPool`). No reveal here. */
  credentials: CredentialSelector;
  /** Composition-root hook: builds a provider from an opaque handle. */
  build: ProviderBuilder;
  /**
   * Failure policy. Defaults to `classifyProviderFailure`; injectable so the
   * policy stays explicit and testable. When the policy says "stop", the
   * original error propagates unchanged and no further attempts are made.
   */
  classify?: (error: unknown) => ProviderFailureAction;
  /**
   * Optional in-memory credential health/cooldown (Phase 10.18). When given,
   * the orchestrator:
   *
   *   - SKIPS any credential that is currently cooling down (recording a
   *     `provider/credential-cooldown` attempt and advancing rotation so other
   *     credentials of the same provider still get a chance);
   *   - MARKS a credential unavailable via `markUnavailable()` exactly when
   *     the existing failure classification already decided to rotate
   *     (reused verbatim — no new classification lives here);
   *   - RESETS the credential's cooldown when its `generate()` SUCCEEDS.
   *
   * It never reveals a value and never appears in agent contracts. When
   * omitted, the orchestration behaves exactly as before (no cooldown).
   */
  health?: ProviderHealth;
}

// ---------------------------------------------------------------------------
// Typed final failure
// ---------------------------------------------------------------------------

/** The machine-readable code attached to one failed attempt. */
export type ProviderFailureCode =
  | ProviderErrorCode
  | "credential-pool/missing-credentials"
  | "provider/credential-cooldown"
  | "provider/unguarded";

/** One failed attempt: WHO failed, with which id — never the secret. */
export interface ProviderFailureSummary {
  provider: ProviderId;
  /** The credential id attempted, when the provider had one. */
  credentialId?: string;
  code: ProviderFailureCode;
}

function describeAttempts(attempts: readonly ProviderFailureSummary[]): string {
  const list = attempts
    .map(
      (attempt) =>
        `${attempt.provider}#${attempt.credentialId ?? "<none>"}(${attempt.code})`,
    )
    .join(", ");
  return `All configured provider credentials are unavailable. Attempted: ${list}.`;
}

/**
 * The typed final failure when every configured provider/credential proved
 * unavailable. Extends `ProviderError` (code `Unavailable`, retryable) so the
 * agent layer's normal `isProviderError`/typed-failure contract still holds,
 * and carries the per-attempt summary for diagnostics — provider ids and
 * credential IDs only, never secret values.
 */
export class ProviderFallbackError extends ProviderError {
  readonly attempted: readonly ProviderFailureSummary[];

  constructor(attempted: readonly ProviderFailureSummary[]) {
    super(ProviderErrorCode.Unavailable, describeAttempts(attempted), true);
    this.name = "ProviderFallbackError";
    this.attempted = Object.freeze([...attempted]);
  }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * Build an `AgentProvider` that transparently performs provider fallback and
 * credential rotation (per the deterministic policy above) across a
 * configured, ordered provider list. The agent sees only `generate()`.
 */
export function createFallbackProvider(
  options: ProviderFallbackOptions,
): AgentProvider {
  const classify = options.classify ?? classifyProviderFailure;

  function codeOf(error: unknown): ProviderFailureCode {
    if (isProviderError(error)) return error.code;
    return "provider/unguarded";
  }

  async function generate(
    request: AgentProviderRequest,
  ): Promise<AgentResponse> {
    const attempts: ProviderFailureSummary[] = [];

    for (const provider of options.providers) {
      const total = options.credentials.all(provider).length;

      if (total === 0) {
        // The provider is configured but has no credentials: exhausted
        // immediately — record and move to the next configured provider.
        attempts.push({
          provider,
          code: "credential-pool/missing-credentials",
        });
        continue;
      }

      for (let attempt = 0; attempt < total; attempt += 1) {
        const handle = options.credentials.obtain(provider);

        if (options.health && !options.health.isAvailable(handle)) {
          // The credential is cooling down (Phase 10.18): skip it and rotate
          // to the next credential so a healthy one still gets a chance. A
          // skipped slot records a distinct typed code — never the value.
          attempts.push({
            provider,
            credentialId: handle.id,
            code: "provider/credential-cooldown",
          });
          options.credentials.rotate(provider);
          continue;
        }

        const instance = options.build(provider, handle);

        try {
          const response = await instance.generate(request);
          // A working credential heals immediately (clears any cooldown).
          options.health?.reset(handle);
          return response;
        } catch (error) {
          const action = classify(error);
          if (action !== "rotate-credential") {
            // Stop immediately; the caller sees the ORIGINAL failure.
            throw error;
          }
          attempts.push({
            provider,
            credentialId: handle.id,
            code: codeOf(error),
          });
          // Reuse the pool's rotation state — advance for the next attempt.
          options.credentials.rotate(provider);
          // Record the temporary unavailability (fixed-duration cooldown, so
          // repeated failures don't extend the window). Classification is
          // EXACTLY the existing `classify` decision above — nothing new.
          options.health?.markUnavailable(handle);
        }
      }
    }

    throw new ProviderFallbackError(attempts);
  }

  return { generate };
}