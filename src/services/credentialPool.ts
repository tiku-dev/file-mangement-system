/**
 * Provider credential pool (Phase 10.11).
 *
 * The smallest provider-independent abstraction that can SUPPLY credentials
 * for a selected provider. Nothing here knows what a credential means to any
 * specific provider — it stores opaque values keyed by provider id and hands
 * out opaque handles that IDENTIFY a credential without carrying its value.
 *
 * Flow:
 *
 *   CredentialPool.register({ provider, value, id? })      ← server-side only
 *   → pool.obtain(provider)                                ← deterministic pick
 *   → OpaqueCredential                                     ← a HANDLE, no secret
 *   → pool.reveal(handle)                                  ← controlled, trusted callers
 *   → value feeds the provider factory (Grok apiKey, ...)
 *
 * Hard rules:
 *
 *   - SERVER-SIDE ONLY: credentials are registered from the server
 *     environment and revealed only to code that constructs providers (the
 *     composition root). They never travel to web / desktop / mobile clients
 *     and never flow through agent contracts (`AgentProvider`,
 *     `AgentResponse`, `ProviderSelection`, serialized conversation state).
 *   - OPAQUE: the values a caller sees are branded handles carrying only an
 *     `id` and a `provider`. The secret itself is retrievable solely through
 *     `reveal()`, which requires a genuine handle produced by THIS pool.
 *   - DETERMINISTIC: selection is stable — `obtain()` returns the CURRENT
 *     credential (the first registered until rotation advances), and
 *     `rotate()` advances a per-provider round-robin pointer EXPLICITLY —
 *     nothing auto-rotates. `all()` exposes every handle in registration
 *     order so future fallback logic can iterate without touching
 *     `AgentProvider`.
 *   - CREDENTIAL-FREE ENTRIES: local providers that need no secret (e.g.
 *     Ollama) are registered via `registerCredentialFree()` — an entry that
 *     occupies ONE selection/rotation slot so orchestration layers can treat
 *     every provider uniformly, but that carries NO secret value and is
 *     REFUSED by `reveal()`. It can never be revealed as a credential, never
 *     conflicts with a real key value (there is no value), and never leaves
 *     this module.
 *   - NEVER LOGGED: this module never logs anything, and error messages and
 *     tests carry only provider ids and credential IDs — never values.
 *
 * Rotation (Phase 10.12) is a PURE SELECTION concern: round-robin order over
 * the registration list, an explicitly requested advance, per-provider
 * isolated state. The pool decides nothing about WHEN to rotate — that
 * decision (e.g. reacting to HTTP/provider errors) stays entirely outside
 * this module. The pool performs no network I/O, no automatic fallback, and
 * no rotation unless `rotate()` is called.
 */
import { ProviderId } from "./providerSelection.js";
import type { ProviderId as ProviderIdType } from "./providerSelection.js";

// `ProviderId` is BOTH the const map (a value) and the provider-id string
// union (a type) in providerSelection. Import the value under its name and
// the type under an alias so the two name-spaces do not collide.

// ---------------------------------------------------------------------------
// Opaque credential handles
// ---------------------------------------------------------------------------

/** Module-private brand so only this pool can mint genuine handles. */
const credentialBrand: unique symbol = Symbol("credential-pool.credential");

/**
 * A handle that identifies a stored credential WITHOUT carrying its value.
 * Constructible only inside this module; external code cannot forge the
 * brand, so a handle is only ever worth revealing through this pool.
 */
export interface OpaqueCredential {
  readonly [credentialBrand]: true;
  /** Stable identifier, unique within the provider's credential set. */
  readonly id: string;
  /** The provider the credential belongs to. */
  readonly provider: ProviderIdType;
}

/**
 * A stored pool entry. Real credentials carry an opaque secret VALUE inside
 * the pool (revealed only through `reveal()`); credential-free entries carry
 * NO value at all, occupy a selection/rotation slot, and are refused by
 * `reveal()` — so they can never be confused with a real API key.
 */
type RegisteredCredential =
  | { kind: "secret"; id: string; provider: ProviderIdType; value: string }
  | { kind: "credential-free"; id: string; provider: ProviderIdType };

function toHandle(entry: RegisteredCredential): OpaqueCredential {
  return { [credentialBrand]: true, id: entry.id, provider: entry.provider };
}

function isGenuineHandle(value: unknown): value is OpaqueCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as OpaqueCredential)[credentialBrand] === true
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CredentialPoolErrorCode =
  | "credential-pool/missing-credentials"
  | "credential-pool/duplicate-credential-id"
  | "credential-pool/empty-credential"
  | "credential-pool/unknown-handle"
  | "credential-pool/not-a-secret";

/**
 * A typed failure from the credential pool. Messages name provider ids and
 * credential IDs only — a credential VALUE is never embedded in an error.
 */
export class CredentialPoolError extends Error {
  readonly code: CredentialPoolErrorCode;
  /** The provider id involved, when known. */
  readonly providerId?: ProviderIdType;
  /** The credential id involved, when known. */
  readonly credentialId?: string;

  constructor(
    code: CredentialPoolErrorCode,
    message: string,
    details?: { providerId?: ProviderIdType; credentialId?: string },
  ) {
    super(message);
    this.name = "CredentialPoolError";
    this.code = code;
    this.providerId = details?.providerId;
    this.credentialId = details?.credentialId;
  }

  /** The provider has no registered credentials. */
  static missing(provider: ProviderIdType): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/missing-credentials",
      `No credentials are registered for provider "${provider}".`,
      { providerId: provider },
    );
  }

  /** A credential id already exists for the provider (ids are unique). */
  static duplicate(provider: ProviderIdType, id: string): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/duplicate-credential-id",
      `A credential with id "${id}" is already registered for provider "${provider}".`,
      { providerId: provider, credentialId: id },
    );
  }

  /** Empty / non-string credential values are rejected at registration. */
  static empty(provider: ProviderIdType): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/empty-credential",
      `Credential value for provider "${provider}" must be a non-empty string.`,
      { providerId: provider },
    );
  }

  /** A handle that this pool cannot map back to a stored credential. */
  static unknownHandle(): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/unknown-handle",
      "Credential handle does not belong to this pool.",
    );
  }

  /**
   * The handle exists but carries NO secret — it is a credential-free entry
   * (e.g. a local provider registered via `registerCredentialFree`).
   * Revealing it is refused so such an entry can never be mistaken for a
   * real provider API key.
   */
  static notSecret(): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/not-a-secret",
      "The credential handle carries no secret value (credential-free provider).",
    );
  }
}

export function isCredentialPoolError(
  error: unknown,
): error is CredentialPoolError {
  return error instanceof CredentialPoolError;
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * A pool of opaque credentials keyed by provider. Registration is exclusive
 * per provider+id, and selection is deterministic: `obtain()` returns the
 * CURRENT credential (first registered until `rotate()` advances to the
 * next, round-robin). Rotation state is isolated per provider and advances
 * only when explicitly requested.
 */
export class CredentialPool {
  private readonly credentials = new Map<
    ProviderIdType,
    RegisteredCredential[]
  >();

  /** Per-provider rotation pointer: index into the registration list. */
  private readonly rotation = new Map<ProviderIdType, number>();

  /** The provider ids that currently have at least one credential. */
  get registeredProviders(): readonly ProviderIdType[] {
    return [...this.credentials.keys()];
  }

  /**
   * Register a server-side credential value under a provider. The value
   * stays inside the pool; callers are handed an opaque `OpaqueCredential`
   * handle.
   *
   * @param id — stable identifier, unique within the provider. Auto-assigned
   *   (`credential-1`, `credential-2`, ...) when omitted.
   * @throws `CredentialPoolError` on empty values or a duplicate id. Values
   *   are never included in error messages.
   */
  register(
    provider: ProviderIdType,
    value: string,
    id?: string,
  ): OpaqueCredential {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw CredentialPoolError.empty(provider);
    }

    const existing = this.credentials.get(provider) ?? [];
    const credentialId = id ?? `credential-${existing.length + 1}`;
    if (existing.some((entry) => entry.id === credentialId)) {
      throw CredentialPoolError.duplicate(provider, credentialId);
    }

    const entry: RegisteredCredential = {
      kind: "secret",
      id: credentialId,
      provider,
      value,
    };
    existing.push(entry);
    this.credentials.set(provider, existing);

    return toHandle(entry);
  }

  /**
   * Register a CREDENTIAL-FREE provider entry (e.g. local Ollama): one slot
   * in the provider's selection/rotation list so orchestration layers (the
   * fallback, which needs a counted entry) can treat every provider
   * uniformly. The entry carries NO secret value and `reveal()` refuses it,
   * so it can never be turned into a provider API key. Ids follow the same
   * deterministic scheme as real credentials.
   *
   * @throws `CredentialPoolError` on a duplicate id.
   */
  registerCredentialFree(
    provider: ProviderIdType,
    id?: string,
  ): OpaqueCredential {
    const existing = this.credentials.get(provider) ?? [];
    const credentialId = id ?? `credential-${existing.length + 1}`;
    if (existing.some((entry) => entry.id === credentialId)) {
      throw CredentialPoolError.duplicate(provider, credentialId);
    }

    const entry: RegisteredCredential = {
      kind: "credential-free",
      id: credentialId,
      provider,
    };
    existing.push(entry);
    this.credentials.set(provider, existing);

    return toHandle(entry);
  }

  /** Whether the provider has at least one registered credential. */
  has(provider: ProviderIdType): boolean {
    return (this.credentials.get(provider)?.length ?? 0) > 0;
  }

  /**
   * Deterministically select the CURRENT credential for the provider —
   * the first registered until `rotate()` is called. `obtain()` NEVER
   * advances rotation; repeated calls return the same handle until an
   * explicit `rotate()`.
   *
   * @throws `CredentialPoolError` (missing) when the provider has none.
   */
  obtain(provider: ProviderIdType): OpaqueCredential {
    const list = this.credentials.get(provider);
    if (list === undefined || list.length === 0) {
      throw CredentialPoolError.missing(provider);
    }
    const index = (this.rotation.get(provider) ?? 0) % list.length;
    const entry = list[index];
    if (entry === undefined) {
      throw CredentialPoolError.missing(provider);
    }
    return toHandle(entry);
  }

  /**
   * Explicitly advance the provider's round-robin pointer to the NEXT
   * credential and return it (already advanced — the caller need not call
   * `obtain()` again). With one credential the pointer cycles back onto the
   * same credential; with zero it behaves exactly like `obtain()`.
   *
   * Rotation state is per provider and NEVER advances implicitly — nothing
   * in this module decides when a credential should rotate.
   *
   * @throws `CredentialPoolError` (missing) when the provider has none.
   */
  rotate(provider: ProviderIdType): OpaqueCredential {
    const list = this.credentials.get(provider);
    if (list === undefined || list.length === 0) {
      throw CredentialPoolError.missing(provider);
    }
    const next = ((this.rotation.get(provider) ?? 0) + 1) % list.length;
    this.rotation.set(provider, next);
    const entry = list[next];
    if (entry === undefined) {
      throw CredentialPoolError.missing(provider);
    }
    return toHandle(entry);
  }

  /**
   * Every registered credential for the provider, in registration order.
   * Exposes the full set for FUTURE rotation / fallback logic without
   * touching `AgentProvider`.
   */
  all(provider: ProviderIdType): readonly OpaqueCredential[] {
    return (this.credentials.get(provider) ?? []).map(toHandle);
  }

  /**
   * The controlled way to obtain the secret VALUE behind an opaque handle.
   * Trusted only for the server-side composition root that constructs
   * providers; results must never flow to agent contracts or clients.
   *
   * @throws `CredentialPoolError` (unknown handle) when the handle was not
   *   minted by this pool.
   */
  reveal(handle: OpaqueCredential): string {
    if (!isGenuineHandle(handle)) {
      throw CredentialPoolError.unknownHandle();
    }
    const list = this.credentials.get(handle.provider);
    const entry = list?.find((candidate) => candidate.id === handle.id);
    if (entry === undefined) {
      throw CredentialPoolError.unknownHandle();
    }
    if (entry.kind !== "secret") {
      // A credential-free entry has no value to hand out — refuse it so the
      // slot can never be mistaken for (or used as) a real API key.
      throw CredentialPoolError.notSecret();
    }
    return entry.value;
  }
}

// Re-export the provider-id type so pool users can annotate without importing
// providerSelection directly.
export type { ProviderIdType };