/**
 * Provider composition root (Phase 10.17).
 *
 * The single, explicit composition/configuration boundary for the AI
 * provider system. This is the ONLY module that:
 *
 *   1. Loads provider configuration from the server config (env-driven).
 *   2. Validates the ordered fallback chain and per-provider settings.
 *   3. Registers credentials into a CredentialPool (server-side only).
 *   4. Constructs provider adapters (the adapters are never constructed
 *      anywhere else — not in provider selection, not in agent code).
 *   5. Wires the credential pool + rotation into the Phase 10.13 fallback
 *      layer to produce the single AgentProvider facade the agent holds.
 *
 * The agent side is completely unaware: it holds a plain `AgentProvider`
 * (`generate(request)` -> `AgentResponse`). No provider id, no credential,
 * no fallback mechanics, no configuration ever appear in agent contracts,
 * policy decisions, or serialized state.
 *
 * Design rules:
 *
 *   - SERVER-SIDE ONLY: credentials are registered here from the
 *     environment and revealed ONLY inside the build hook (which
 *     constructs the adapters). They never enter agent contracts, tool
 *     policy, API responses, serialized state, or logs.
 *   - NO PARALLEL INTERFACES: this module composes the EXISTING
 *     CredentialPool (Phase 10.11/10.12), createFallbackProvider
 *     (Phase 10.13), and the real adapter factories (Phases 10.9/10.14/
 *     10.15/10.16). Adding a future provider is a LOCALIZED change: one
 *     settings entry, one adapter case (and, if it needs no credential,
 *     simply not adding it to REQUIRES_CREDENTIAL). No agent orchestration
 *     code changes.
 *   - DETERMINISTIC: the chain is explicitly configured (defaulting to the
 *     single `AI_PROVIDER`), the credential pool preserves registration
 *     order, and the fallback layer iterates in the configured order.
 *   - OLLAMA'S NO-CREDENTIAL PATH IS PRESERVED: local Ollama needs no
 *     secret. It gets exactly ONE credential-free pool entry (registered via
 *     `CredentialPool.registerCredentialFree()` — no value stored, refused
 *     by `reveal()`) so the fallback layer's per-provider credential loop
 *     (which is not redesigned here) attempts it exactly once; the build
 *     hook never reveals a value and constructs the local adapter instead.
 *   - FAIL CLEARLY AT COMPOSITION TIME: an empty/unknown/duplicate chain,
 *     malformed settings, a missing required model, or a required-credential
 *     provider with no credentials raises a typed `ProviderCompositionError`
 *     with an operator-actionable message — synchronously, before any
 *     provider is contacted. Every provider in the chain is validated.
 *   - NO CREDENTIAL LEAKAGE: `CredentialPool.reveal()` is called ONLY
 *     inside the build hook. Composition errors carry provider ids and
 *     credential ids — never credential values — and this module never logs
 *     anything.
 *   - HEALTH STAYS SERVER-SIDE: the Phase 10.18 in-memory cooldown is wired
 *     into the fallback (skip cooling-down credentials, mark only
 *     rotate-eligible failures, reset on success), keyed by opaque handles.
 *     It never leaves this boundary: no agent exposure, no persistence, no
 *     values, no real provider contact.
 *
 * The running server calls `composeDefaultProviderStack()` once at startup
 * (when the first provider-backed agent is wired); the returned
 * `{ provider }` is handed to the agent layer and everything else stays
 * behind this boundary.
 */
import type { AgentProvider } from "./provider.js";
import { CredentialPool } from "./credentialPool.js";
import {
  createFallbackProvider,
  type ProviderBuilder,
} from "./providerFallback.js";
import {
  isProviderId,
  KNOWN_PROVIDER_IDS,
  ProviderId,
  type ProviderId as ProviderIdType,
} from "./providerSelection.js";
import { createGrokProvider } from "./grokProvider.js";
import { createGeminiProvider } from "./geminiProvider.js";
import { createOpenRouterProvider } from "./openrouterProvider.js";
import { createOllamaProvider } from "./ollamaProvider.js";
import { config } from "../config.js";
import {
  createProviderHealth,
  type ProviderHealth,
} from "./providerHealth.js";
import {
  validateProviderConfiguration,
  isValidProviderBaseUrl,
  type ProviderDiagnosticsReport,
} from "./providerDiagnostics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-provider settings from the environment-driven config. */
export interface ProviderSettings {
  /** Model sent to the provider. Required — no silent provider default. */
  model: string;
  /** Provider API base URL. */
  baseUrl: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

/** Explicit composition options. Every field is passed explicitly. */
export interface ProviderCompositionOptions {
  /** Ordered fallback chain: provider ids tried in exactly this order. */
  chain: readonly string[];
  /** Per-provider settings for every id in the chain. */
  settings: Readonly<Record<string, ProviderSettings>>;
  /** Per-provider credential value lists (empty for no-credential providers). */
  credentials: Readonly<Record<string, readonly string[]>>;
  /**
   * Injectable adapter construction seam (defaults to the real built-in
   * adapters). Lets tests/future hosts override construction without
   * touching the composition logic; still receives the revealed value on the
   * server side only.
   */
  adapterFactory?: (
    provider: ProviderIdType,
    settings: ProviderSettings,
    credentialValue: string | undefined,
  ) => AgentProvider;
  /**
   * Injectable in-memory credential health/cooldown (Phase 10.18). Defaults to
   * a fresh `createProviderHealth` wired to `config.providerCooldownMs`, so
   * the composed stack ALWAYS avoids hammering a credential that just failed
   * with a safe, replaceable error. Passing an instance lets tests/hosts own
   * the cooldown window and clock. Never exposed past this boundary.
   */
  health?: ProviderHealth;
}

/** The composed provider stack returned by composeProviderStack. */
export interface ComposedProviderStack {
  /** The agent-ready facade (fallback + credential rotation). */
  provider: AgentProvider;
  /** The credential pool behind the facade (server-side only). */
  credentials: CredentialPool;
  /** The validated fallback chain in configured order. */
  chain: readonly ProviderIdType[];
  /** Providers in the chain that REQUIRE a credential (and were given one). */
  credentialProviders: readonly ProviderIdType[];
  /** Providers in the chain that require NO credential (e.g. Ollama). */
  credentialFreeProviders: readonly ProviderIdType[];
  /**
   * Deterministic, safe configuration diagnostics (Phase 10.19) for the
   * composed stack — computed at composition/startup time. Never contains a
   * credential value or a secret-bearing URL; safe for server logs. For a
   * successfully composed stack this is always `{ overallStatus: "ok" }`.
   */
  diagnostics: ProviderDiagnosticsReport;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProviderCompositionErrorCode =
  | "provider-composition/empty-order"
  | "provider-composition/unknown-provider"
  | "provider-composition/duplicate-provider"
  | "provider-composition/missing-settings"
  | "provider-composition/missing-model"
  | "provider-composition/missing-credentials"
  | "provider-composition/invalid-configuration"
  | "provider-composition/unregistered-adapter";

/**
 * A typed failure from the composition root. Messages carry provider ids and
 * credential ids only — never credential values. Distinct from
 * `ProviderError` (an EXTERNAL provider failure) and from `AppError` (the
 * HTTP envelope): this type names problems with the server-side provider
 * configuration itself, surfacing at composition/startup time.
 */
export class ProviderCompositionError extends Error {
  readonly code: ProviderCompositionErrorCode;
  /** The provider id the failure concerns, when known. */
  readonly providerId?: ProviderIdType;

  constructor(
    code: ProviderCompositionErrorCode,
    message: string,
    providerId?: ProviderIdType,
  ) {
    super(message);
    this.name = "ProviderCompositionError";
    this.code = code;
    this.providerId = providerId;
  }
}

export function isProviderCompositionError(
  error: unknown,
): error is ProviderCompositionError {
  return error instanceof ProviderCompositionError;
}

/** Providers that cannot operate without a credential. */
const REQUIRES_CREDENTIAL: ReadonlySet<ProviderIdType> = new Set([
  ProviderId.Grok,
  ProviderId.Gemini,
  ProviderId.OpenRouter,
]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateChain(chain: readonly string[]): ProviderIdType[] {
  if (chain.length === 0) {
    throw new ProviderCompositionError(
      "provider-composition/empty-order",
      "Provider fallback chain is empty. At least one provider is required.",
    );
  }
  const seen = new Set<string>();
  const resolved: ProviderIdType[] = [];
  for (const entry of chain) {
    if (!isProviderId(entry)) {
      throw new ProviderCompositionError(
        "provider-composition/unknown-provider",
        `Unknown provider id in fallback chain: "${entry}". ` +
          `Known providers: ${KNOWN_PROVIDER_IDS.join(", ")}.`,
        entry as ProviderIdType,
      );
    }
    if (seen.has(entry)) {
      throw new ProviderCompositionError(
        "provider-composition/duplicate-provider",
        `Provider "${entry}" appears more than once in the fallback chain.`,
        entry as ProviderIdType,
      );
    }
    seen.add(entry);
    resolved.push(entry as ProviderIdType);
  }
  return resolved;
}

function validateSettings(
  chain: readonly ProviderIdType[],
  settings: Readonly<Record<string, ProviderSettings>>,
): void {
  for (const id of chain) {
    const s = settings[id];
    if (s === undefined || s === null) {
      throw new ProviderCompositionError(
        "provider-composition/missing-settings",
        `Provider "${id}" has no settings entry in the provider configuration.`,
        id,
      );
    }
    if (typeof s.model !== "string" || s.model.trim().length === 0) {
      throw new ProviderCompositionError(
        "provider-composition/missing-model",
        `Provider "${id}" has no model configured.`,
        id,
      );
    }
    if (typeof s.baseUrl !== "string" || s.baseUrl.trim().length === 0) {
      throw new ProviderCompositionError(
        "provider-composition/invalid-configuration",
        `Provider "${id}" has an invalid (empty) base URL.`,
        id,
      );
    }
    // Phase 10.19: the base URL must be a parseable absolute http(s) URL —
    // mirrors the diagnostics layer so a composed stack always reports "ok".
    if (!isValidProviderBaseUrl(s.baseUrl)) {
      throw new ProviderCompositionError(
        "provider-composition/invalid-configuration",
        `Provider "${id}" has a malformed base URL (expected an absolute http(s) URL).`,
        id,
      );
    }
    if (
      typeof s.timeoutMs !== "number" ||
      !Number.isFinite(s.timeoutMs) ||
      s.timeoutMs <= 0
    ) {
      throw new ProviderCompositionError(
        "provider-composition/invalid-configuration",
        `Provider "${id}" has an invalid timeout (expected a positive number of milliseconds).`,
        id,
      );
    }
  }
}

function validateCredentials(
  chain: readonly ProviderIdType[],
  credentials: Readonly<Record<string, readonly string[]>>,
): void {
  for (const id of chain) {
    if (!REQUIRES_CREDENTIAL.has(id)) continue;
    const creds = credentials[id];
    if (creds === undefined || creds.length === 0) {
      throw new ProviderCompositionError(
        "provider-composition/missing-credentials",
        `Provider "${id}" requires a credential but none are configured.`,
        id,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter construction (the ONLY reveal/construction site)
// ---------------------------------------------------------------------------

/**
 * Construct ONE concrete provider adapter for a composed stack. This is the
 * only place in the codebase that news the real adapters, and the only place
 * a credential VALUE is revealed. Credential-free providers (Ollama) pass no
 * credential and their credential-free pool entry carries no secret.
 */
function buildBuiltinAdapter(
  provider: ProviderIdType,
  settings: ProviderSettings,
  credentialValue: string | undefined,
): AgentProvider {
  switch (provider) {
    case ProviderId.Grok:
      return createGrokProvider({
        apiKey: credentialValue ?? "",
        model: settings.model,
        baseUrl: settings.baseUrl,
        timeoutMs: settings.timeoutMs,
      });
    case ProviderId.Gemini:
      return createGeminiProvider({
        apiKey: credentialValue ?? "",
        model: settings.model,
        baseUrl: settings.baseUrl,
        timeoutMs: settings.timeoutMs,
      });
    case ProviderId.OpenRouter:
      return createOpenRouterProvider({
        apiKey: credentialValue ?? "",
        model: settings.model,
        baseUrl: settings.baseUrl,
        timeoutMs: settings.timeoutMs,
      });
    case ProviderId.Ollama:
      // Local Ollama needs no credential — the constructed adapter is
      // unauthenticated and the pool's credential-free entry is never
      // revealed (the pool refuses it with `not-a-secret`).
      return createOllamaProvider({
        model: settings.model,
        baseUrl: settings.baseUrl,
        timeoutMs: settings.timeoutMs,
      });
    default: {
      const exhaustive: never = provider;
      throw new ProviderCompositionError(
        "provider-composition/unregistered-adapter",
        `No adapter factory is registered for provider "${String(exhaustive)}".`,
        exhaustive as ProviderIdType,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Compose the provider stack from explicit options.
 *
 * Validates the chain and settings, registers every chain provider's
 * credentials (and a credential-free entry for providers that require none),
 * and wires the pool through the fallback layer. Throws a typed
 * `ProviderCompositionError` synchronously on any invalid configuration —
 * before any provider is contacted.
 */
export function composeProviderStack(
  options: ProviderCompositionOptions,
): ComposedProviderStack {
  const chain = validateChain(options.chain);
  validateSettings(chain, options.settings);
  validateCredentials(chain, options.credentials);

  const credentialProviders: ProviderIdType[] = [];
  const credentialFreeProviders: ProviderIdType[] = [];
  for (const id of chain) {
    const creds = options.credentials[id];
    if (creds !== undefined && creds.length > 0) {
      credentialProviders.push(id);
    } else {
      credentialFreeProviders.push(id);
    }
  }

  const credentials = new CredentialPool();
  for (const id of credentialProviders) {
    for (const value of options.credentials[id] ?? []) {
      // Ids auto-assigned (credential-1, credential-2, ...) deterministically,
      // matching registration order across the chain.
      credentials.register(id, value);
    }
  }
  for (const id of credentialFreeProviders) {
    // One secret-less slot so the fallback's per-provider loop attempts the
    // provider exactly once; the pool refuses to reveal it.
    credentials.registerCredentialFree(id);
  }

  const build: ProviderBuilder = (provider, handle) => {
    const settings = options.settings[provider];
    if (settings === undefined) {
      throw new ProviderCompositionError(
        "provider-composition/missing-settings",
        `Provider "${provider}" has no settings for adapter construction.`,
        provider,
      );
    }
    if (credentialFreeProviders.includes(provider)) {
      if (options.adapterFactory) {
        return options.adapterFactory(provider, settings, undefined);
      }
      return buildBuiltinAdapter(provider, settings, undefined);
    }
    const value = credentials.reveal(handle);
    if (options.adapterFactory) {
      return options.adapterFactory(provider, settings, value);
    }
    return buildBuiltinAdapter(provider, settings, value);
  };

  const provider = createFallbackProvider({
    providers: chain,
    credentials,
    build,
    // Phase 10.18 health/cooldown: injectable, defaulting to the configured
    // cooldown window. The fallback skips a cooling-down credential before
    // building the adapter, and marks it only when it already classified the
    // failure as credential-rotatable — no new classification here.
    health: options.health ?? createProviderHealth({ cooldownMs: config.providerCooldownMs }),
  });

  return {
    provider,
    credentials,
    chain,
    credentialProviders,
    credentialFreeProviders,
    // Phase 10.19: deterministic, secret-free configuration diagnostics run at
    // composition time. Since compose throws on any invalid configuration,
    // a composed stack always reports overallStatus "ok" here; operators that
    // want the FULL picture even for a broken configuration call
    // validateProviderConfiguration directly (which never throws).
    diagnostics: validateProviderConfiguration({
      chain: options.chain,
      settings: options.settings,
      credentials: options.credentials,
    }),
  };
}

// ---------------------------------------------------------------------------
// Default (environment-driven) composition
// ---------------------------------------------------------------------------

/**
 * The default composition options, read from the server configuration. The
 * fallback chain is `AI_PROVIDER_FALLBACK` (default: just `AI_PROVIDER`), the
 * per-provider settings are the environment-configured model / base URL /
 * timeout, and the credentials are the environment-provided key lists.
 */
export function defaultProviderCompositionOptions(): ProviderCompositionOptions {
  return {
    chain: config.aiProviderFallback,
    settings: {
      [ProviderId.Grok]: {
        model: config.grok.model,
        baseUrl: config.grok.baseUrl,
        timeoutMs: config.grok.timeoutMs,
      },
      [ProviderId.Gemini]: {
        model: config.gemini.model,
        baseUrl: config.gemini.baseUrl,
        timeoutMs: config.gemini.timeoutMs,
      },
      [ProviderId.OpenRouter]: {
        model: config.openrouter.model ?? "",
        baseUrl: config.openrouter.baseUrl,
        timeoutMs: config.openrouter.timeoutMs,
      },
      [ProviderId.Ollama]: {
        model: config.ollama.model ?? "",
        baseUrl: config.ollama.baseUrl,
        timeoutMs: config.ollama.timeoutMs,
      },
    },
    credentials: {
      [ProviderId.Grok]: config.grok.credentials,
      [ProviderId.Gemini]: config.gemini.credentials,
      [ProviderId.OpenRouter]: config.openrouter.credentials,
    },
  };
}

/**
 * Compose the server's provider stack from environment configuration. The
 * single startup entry point: the app calls this once when wiring the agent
 * and keeps only the returned `{ provider }`. Throws a typed
 * `ProviderCompositionError` when the configured provider system is invalid.
 */
export function composeDefaultProviderStack(): ComposedProviderStack {
  return composeProviderStack(defaultProviderCompositionOptions());
}