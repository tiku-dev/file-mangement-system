/**
 * AI provider selection layer (Phase 10.10).
 *
 * The smallest abstraction between "which AI provider is configured?" and
 * "an `AgentProvider` instance the agent can call". It lets the agent choose
 * an `AgentProvider` by a configured provider NAME without ever naming Grok,
 * Gemini, OpenRouter, or Ollama in agent code.
 *
 *   config.aiProvider ("grok")            ← configured provider name
 *   → ProviderRegistry.resolve({ provider, config? })
 *       → registered ProviderFactory      ← named provider implementation
 *   → AgentProvider                       ← ready to hand to the agent layer
 *
 * Design rules:
 *
 *   - NAMED REGISTRY ONLY: providers are registered under a typed
 *     `ProviderId` (from the `ProviderId` map — extend the map to add future
 *     providers). Agent contracts (Phase 10.2 `AgentProvider`, Phase 10.4
 *     loop, Phase 10.8 persistence) are NEVER touched when a provider is
 *     added.
 *   - CONSTRUCTION IS SEPARATE FROM ORCHESTRATION: providers come from
 *     registered factories. Orchestration (the agent loop, persistent turns)
 *     receives a ready `AgentProvider` and never imports this module or any
 *     concrete adapter. Since Phase 10.17 the DEFAULT construction path for
 *     the running server is the composition root (`providerComposition.ts`);
 *     this module stays a pure, provider-agnostic registry primitive.
 *   - NO EXECUTION HERE: resolving a provider only builds it. It never
 *     invokes `generate`, never executes tools, never touches policy /
 *     `invokeTool` / `runPersistentTurn` — those stay exclusively in the
 *     agent layer.
 *   - DETERMINISTIC: the same configured name always resolves through the
 *     same registered factory with the same configuration. Registration is
 *     exclusive — a provider id cannot be silently re-registered.
 *   - FAIL CLEARLY: requesting a provider that is not registered throws a
 *     typed `ProviderRegistryError` listing the registered ids; a configured
 *     name that is not a known provider id is rejected the same way.
 */
import type { AgentProvider } from "./provider.js";

/**
 * The typed identifier for every provider the selection layer knows about.
 * Extend this const object (and nothing else) to add future providers — the
 * agent contracts remain untouched.
 */
export const ProviderId = {
  /** Grok — served by the xAI API through the Phase 10.9 adapter. */
  Grok: "grok",
  /** Gemini — served by the Google AI Studio API through the Phase 10.14 adapter. */
  Gemini: "gemini",
  /** OpenRouter — served by the OpenAI-compatible chat completions API through the Phase 10.15 adapter. */
  OpenRouter: "openrouter",
  /** Ollama — served by the local /api/chat endpoint through the Phase 10.16 adapter (no credential). */
  Ollama: "ollama",
} as const;

/** The string union of every known provider id. */
export type ProviderId = (typeof ProviderId)[keyof typeof ProviderId];

/** Every known provider id, as an array (for clear error messages). */
export const KNOWN_PROVIDER_IDS: readonly ProviderId[] = Object.values(ProviderId);

export function isProviderId(value: string): value is ProviderId {
  return (KNOWN_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * A configured provider selection: the provider NAME, plus an optional,
 * provider-specific configuration bag the factory consumes.
 */
export interface ProviderSelection<TConfig = unknown> {
  /** The registered provider to resolve. */
  provider: ProviderId;
  /** Provider-specific options handed to the registered factory. Optional. */
  config?: TConfig;
}

/**
 * A factory that builds an `AgentProvider` from a provider-specific
 * configuration. Providers are ROOTED here (a Grok adapter, a future Gemini
 * adapter) — never in agent orchestration code.
 */
export interface ProviderFactory<TConfig = unknown> {
  (config: TConfig | undefined): AgentProvider;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProviderRegistryErrorCode =
  | "provider-selection/duplicate-registration"
  | "provider-selection/unknown-provider";

/**
 * A typed failure from the provider selection layer. Distinct from
 * `ProviderError` (a failure from an EXTERNAL provider) and from `AppError`
 * (the HTTP envelope): this type names problems with the selection itself —
 * a duplicate registration, or a requested provider that is not registered.
 */
export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;
  /** The provider id the failure concerns. */
  readonly providerId: string;

  constructor(
    code: ProviderRegistryErrorCode,
    providerId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRegistryError";
    this.code = code;
    this.providerId = providerId;
  }

  /** Registering the same provider id twice — non-deterministic by design. */
  static duplicate(providerId: string): ProviderRegistryError {
    return new ProviderRegistryError(
      "provider-selection/duplicate-registration",
      providerId,
      `Provider "${providerId}" is already registered.`,
    );
  }

  /** A requested provider name that has no registered factory. */
  static unknown(
    providerId: string,
    registered: readonly string[],
  ): ProviderRegistryError {
    const known = registered.length > 0 ? registered.join(", ") : "none";
    return new ProviderRegistryError(
      "provider-selection/unknown-provider",
      providerId,
      `No provider "${providerId}" is registered. Registered providers: ${known}.`,
    );
  }
}

export function isProviderRegistryError(
  error: unknown,
): error is ProviderRegistryError {
  return error instanceof ProviderRegistryError;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * A named registry of provider factories. Deterministic: each provider id
 * maps to exactly one factory (duplicate registration is rejected), and
 * resolving a name always runs that same factory. Resolution builds a fresh
 * provider per call — no shared mutable state, no cross-request leakage.
 */
export class ProviderRegistry {
  private readonly factories = new Map<ProviderId, ProviderFactory>();

  /** The provider ids currently registered, in registration order. */
  get registeredProviderIds(): readonly ProviderId[] {
    return [...this.factories.keys()];
  }

  /**
   * Register a named provider factory. Throws a typed
   * `ProviderRegistryError` when `provider` is already registered — an
   * exclusivity guarantee keeps resolution deterministic.
   */
  register<TConfig = unknown>(
    provider: ProviderId,
    factory: ProviderFactory<TConfig>,
  ): void {
    if (this.factories.has(provider)) {
      throw ProviderRegistryError.duplicate(provider);
    }
    this.factories.set(provider, factory as ProviderFactory);
  }

  /** Whether a provider factory is currently registered under the id. */
  has(provider: ProviderId): boolean {
    return this.factories.has(provider);
  }

  /**
   * Resolve a configured provider selection into a ready `AgentProvider`.
   * Building a provider never invokes it — no `generate`, no tool execution,
   * no network.
   *
   * @throws `ProviderRegistryError` (unknown) when the requested provider id
   *   has no registered factory.
   */
  resolve<TConfig = unknown>(
    selection: ProviderSelection<TConfig>,
  ): AgentProvider {
    const factory = this.factories.get(selection.provider);
    if (factory === undefined) {
      throw ProviderRegistryError.unknown(
        selection.provider,
        this.registeredProviderIds,
      );
    }
    return (factory as ProviderFactory<TConfig>)(selection.config);
  }
}