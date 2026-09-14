/**
 * Provider credential health (Phase 10.18).
 *
 * A small, IN-MEMORY health/cooldown component for individual provider
 * credentials. It tracks only "temporary unavailability" — state is keyed by
 * (provider, opaque credential handle) — and is deliberately orthogonal to
 * selection/rotation (the CredentialPool), orchestration (the fallback layer),
 * and the agent boundary (it never appears in agent contracts).
 *
 * Responsibilities are narrowly scoped:
 *
 *   - identify health state by provider + opaque credential handle;
 *   - mark a credential temporarily unavailable (enter cooldown);
 *   - check whether a credential is currently available;
 *   - deterministic cooldown expiry via an injected clock;
 *   - reset / clear a credential's cooldown.
 *
 * Guarantees:
 *
 *   - IN MEMORY ONLY: no PostgreSQL, no files, no background jobs. State is a
 *     plain map and disappears with the process.
 *   - NO CREDENTIAL VALUES: this module stores only provider ids and
 *     credential ids (the handle's non-secret identity). It never receives a
 *     value, never reveals one, and never includes one in errors or state.
 *   - COLD DATA: an unknown (never-seen) provider/credential is AVAILABLE.
 *     State is created lazily on `markUnavailable()` and pruned when a
 *     cooldown expires.
 *   - PROVIDER ISOLATION: each (provider, credential id) pair has its own
 *     independent cooldown entry; marking or resetting one never touches
 *     another provider's credentials.
 *   - DETERMINISTIC: the observed behavior of every method is a pure function
 *     of the (provider, id) and the injected clock `now()`. No randomness, no
 *     timers, no wall-clock reads inside the component.
 *
 * Cooldown policy — FIXED DURATION (chosen for this phase):
 *
 *   - `markUnavailable()` moves a credential into cooldown for a FIXED window
 *     of `cooldownMs` starting at the mark time: `deadline = now() + cooldownMs`.
 *   - REPEATED FAILURES DO NOT EXTEND OR REPLACE THE WINDOW: while a
 *     credential is already cooling down, further `markUnavailable()` calls
 *     return the EXISTING deadline unchanged (first-failure-wins). This keeps
 *     flapping credentials from postponing recovery indefinitely.
 *   - After the window expires the credential is available again; a NEW
 *     failure then starts a fresh window. Cooldown is therefore never
 *     permanent.
 *   - No exponential backoff yet — that is intentionally deferred.
 *
 * Failure classification is NOT this component's job: marking is driven by the
 * fallback layer, which reuses its existing `classifyProviderFailure` policy.
 * This module never looks at a raw error; it only records the OUTCOME that
 * orchestration already decided to react to.
 */
import {
  isProviderId,
  type ProviderId as ProviderIdType,
} from "./providerSelection.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProviderHealthErrorCode =
  | "provider-health/invalid-handle"
  | "provider-health/unknown-provider";

/**
 * A typed failure from the health/cooldown component. Messages carry provider
 * and credential ids only — never a credential value (the component never sees
 * values, and a handle is refused before anything secret could exist).
 */
export class ProviderHealthError extends Error {
  readonly code: ProviderHealthErrorCode;
  /** The provider id involved, when known. */
  readonly providerId?: ProviderIdType;
  /** The credential id involved, when known. */
  readonly credentialId?: string;

  constructor(
    code: ProviderHealthErrorCode,
    message: string,
    details?: { providerId?: ProviderIdType; credentialId?: string },
  ) {
    super(message);
    this.name = "ProviderHealthError";
    this.code = code;
    this.providerId = details?.providerId;
    this.credentialId = details?.credentialId;
  }

  /** The handle is not a usable provider+credential reference. */
  static invalidHandle(): ProviderHealthError {
    return new ProviderHealthError(
      "provider-health/invalid-handle",
      "Credential health requires a valid opaque credential handle.",
    );
  }

  /** The handle references a provider id this system does not know. */
  static unknownProvider(provider: string): ProviderHealthError {
    return new ProviderHealthError(
      "provider-health/unknown-provider",
      `Credential health does not track provider "${provider}".`,
      { providerId: provider as ProviderIdType },
    );
  }
}

export function isProviderHealthError(
  error: unknown,
): error is ProviderHealthError {
  return error instanceof ProviderHealthError;
}

// ---------------------------------------------------------------------------
// Handle shape
// ---------------------------------------------------------------------------

/**
 * The credential identity the component keys on. Structural (provider + id),
 * so the real `OpaqueCredential` handles from the CredentialPool satisfy it —
 * the secret value never appears here. Ids are unique within a provider, so
 * the pair is a stable identity for health state.
 */
export interface ProviderHealthRef {
  /** Known provider id from the provider-selection layer. */
  provider: string;
  /** Credential id, unique within the provider. */
  id: string;
}

function isHandle(value: unknown): value is ProviderHealthRef {
  if (typeof value !== "object" || value === null) return false;
  const provider = (value as { provider?: unknown }).provider;
  const id = (value as { id?: unknown }).id;
  return (
    typeof provider === "string" &&
    provider.length > 0 &&
    typeof id === "string" &&
    id.length > 0
  );
}

function toRef(handle: ProviderHealthRef): {
  provider: ProviderIdType;
  id: string;
} {
  if (!isHandle(handle)) {
    throw ProviderHealthError.invalidHandle();
  }
  if (!isProviderId(handle.provider)) {
    throw ProviderHealthError.unknownProvider(handle.provider);
  }
  return { provider: handle.provider, id: handle.id };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ProviderHealthOptions {
  /**
   * FIXED cooldown duration in milliseconds. Configurable by the caller
   * (the composition root supplies an environment-configurable default); the
   * component never hard-codes its own value.
   */
  cooldownMs: number;
  /**
   * Injected clock in milliseconds. Defaults to `Date.now`. Deterministic in
   * tests: the component observes time ONLY through this function.
   */
  now?: () => number;
}

export interface ProviderHealth {
  /**
   * Whether the credential can currently be used — false exactly while it is
   * in cooldown (now() < deadline). Unknown providers raise `ProviderHealthError`
   * (typed), so the fallback never silently skips on a misconfigured id.
   */
  isAvailable(handle: ProviderHealthRef): boolean;
  /**
   * Mark the credential temporarily unavailable. Returns the EFFECTIVE
   * cooldown deadline: a fresh window (`now() + cooldownMs`) when the
   * credential was available, or the EXISTING deadline when it was already
   * cooling down (fixed-duration policy — no extension, no replacement).
   */
  markUnavailable(handle: ProviderHealthRef): number;
  /** Immediately clear the credential's cooldown. Idempotent. */
  reset(handle: ProviderHealthRef): void;
  /**
   * The cooldown deadline (`now() < deadline` ⇔ cooling down), or `undefined`
   * when the credential is available / not tracked. Expired entries are
   * pruned on read.
   */
  cooldownExpiresAt(handle: ProviderHealthRef): number | undefined;
}

interface CooldownEntry {
  provider: ProviderIdType;
  id: string;
  deadline: number;
}

/** Separator that cannot appear in a provider id or credential id. */
const KEY_SEPARATOR = "\u0000";

export function createProviderHealth(
  options: ProviderHealthOptions,
): ProviderHealth {
  const cooldownMs = options.cooldownMs;
  const now = options.now ?? (() => Date.now());

  if (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new RangeError(
      "ProviderHealth cooldownMs must be a finite, non-negative number.",
    );
  }

  const state = new Map<string, CooldownEntry>();

  function lookup(ref: ProviderHealthRef): { provider: ProviderIdType; id: string; deadline: number } | undefined {
    const { provider, id } = toRef(ref);
    const key = `${provider}${KEY_SEPARATOR}${id}`;
    const entry = state.get(key);
    if (entry === undefined) return undefined;
    if (now() >= entry.deadline) {
      // Expired: prune the entry so cold-data state stays clean.
      state.delete(key);
      return undefined;
    }
    return entry;
  }

  function cooldownExpiresAt(ref: ProviderHealthRef): number | undefined {
    return lookup(ref)?.deadline;
  }

  function isAvailable(ref: ProviderHealthRef): boolean {
    return lookup(ref) === undefined;
  }

  function markUnavailable(ref: ProviderHealthRef): number {
    const current = lookup(ref);
    if (current !== undefined) {
      // Fixed-duration policy: already cooling down — return the ORIGINAL
      // deadline; repeated failures neither extend nor replace the window.
      return current.deadline;
    }
    const { provider, id } = toRef(ref);
    const deadline = now() + cooldownMs;
    state.set(`${provider}${KEY_SEPARATOR}${id}`, {
      provider,
      id,
      deadline,
    });
    return deadline;
  }

  function reset(ref: ProviderHealthRef): void {
    const { provider, id } = toRef(ref);
    state.delete(`${provider}${KEY_SEPARATOR}${id}`);
  }

  return { isAvailable, markUnavailable, reset, cooldownExpiresAt };
}