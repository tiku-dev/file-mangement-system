/**
 * Environment-driven configuration.
 *
 * All secrets, including the Grok API key, must come from the environment —
 * never from source code or version control.
 */

function intFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envStringOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function listFromEnv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Collect all credential values for a provider prefix from the environment.
 *
 * Convention: PREFIX_API_KEY (primary), then PREFIX_API_KEY_1,
 * PREFIX_API_KEY_2, etc. (extras, in ascending numeric order). Returns
 * the full ordered list (empty when none are configured). The primary key
 * is always first in the returned list so the credential pool rotation
 * order matches the operator intent.
 */
function credentialsFromEnv(prefix: string): string[] {
  const primary = envStringOrUndefined(process.env[`${prefix}_API_KEY`]);
  const extras: string[] = [];
  for (let n = 1; ; n += 1) {
    const value = envStringOrUndefined(
      process.env[`${prefix}_API_KEY_${n}`],
    );
    if (value === undefined) break;
    extras.push(value);
  }
  return primary ? [primary, ...extras] : extras;
}

/**
 * Browser/webview origins allowed to call the API when none are configured.
 * Covers the Vite dev servers used by this repo; Tauri webview origins can be
 * added via CORS_ORIGINS when the desktop app starts calling the API.
 */
const DEFAULT_DEV_ORIGINS: string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8443",
  "http://127.0.0.1:8443",
  // Desktop webview origins (Tauri v2): macOS/Linux use tauri://localhost,
  // Windows uses http://tauri.localhost — needed when the desktop app calls the API.
  "tauri://localhost",
  "http://tauri.localhost",
];

export const config = {
  /** TCP port for the HTTP server. */
  port: intFromEnv(process.env.PORT) ?? 4000,
  /** Bind address. Loopback by default — never expose the API unintentionally. */
  host: process.env.HOST ?? "127.0.0.1",
  /** Browser/webview origins allowed by CORS. */
  corsOrigins: listFromEnv(process.env.CORS_ORIGINS) ?? DEFAULT_DEV_ORIGINS,
  /** Session lifetime in hours (Phase 7). Safe production-oriented default. */
  sessionTtlHours: Math.max(1, intFromEnv(process.env.SESSION_TTL_HOURS) ?? 12),
  /**
   * Grok (xAI) provider settings (Phase 10.9).
   *
   * The API key is a production secret: read from the environment only,
   * never committed. The model default lives HERE in configuration (not
   * in the adapter's logic) so operators can switch models via
   * `GROK_MODEL` without a code change.
   */
  grok: {
    /** xAI API key. `undefined` until `GROK_API_KEY` is set in env/.env. */
    apiKey: envStringOrUndefined(process.env.GROK_API_KEY),
    /** All Grok credential values in rotation order (primary first). */
    credentials: credentialsFromEnv("GROK"),
    /** Model sent to the xAI API. Default via configuration. */
    model: process.env.GROK_MODEL ?? "grok-3",
    /** xAI API base URL. */
    baseUrl: process.env.GROK_BASE_URL ?? "https://api.x.ai/v1",
    /** Request timeout in milliseconds (Phase 10.9 HTTP client). */
    timeoutMs: Math.max(
      1000,
      intFromEnv(process.env.GROK_TIMEOUT_MS) ?? 60_000,
    ),
  },
  /**
   * Gemini (Google AI) provider settings (Phase 10.14).
   *
   * The API key is a production secret: read from the environment only,
   * never committed. Model, base URL, and timeout mirror the Grok block —
   * all operators can change them via `GEMINI_*` without a code change.
   */
  gemini: {
    /** Gemini API key. `undefined` until `GEMINI_API_KEY` is set in env/.env. */
    apiKey: envStringOrUndefined(process.env.GEMINI_API_KEY),
    /** All Gemini credential values in rotation order (primary first). */
    credentials: credentialsFromEnv("GEMINI"),
    /** Model sent to the Gemini API. Default via configuration. */
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    /** Google AI Studio API base URL. */
    baseUrl:
      process.env.GEMINI_BASE_URL ??
      "https://generativelanguage.googleapis.com/v1beta",
    /** Request timeout in milliseconds (Phase 10.14 HTTP client). */
    timeoutMs: Math.max(
      1000,
      intFromEnv(process.env.GEMINI_TIMEOUT_MS) ?? 60_000,
    ),
  },
  /**
   * OpenRouter provider settings (Phase 10.15).
   *
   * OpenRouter routes a single request to any upstream model, so the model
   * slug is an operator choice (`OPENROUTER_MODEL`, e.g.
   * "anthropic/claude-sonnet-4") — NOT hard-coded here or in the adapter.
   * The API key is a production secret: read from the environment only,
   * never committed.
   */
  openrouter: {
    /** OpenRouter API key. `undefined` until `OPENROUTER_API_KEY` is set. */
    apiKey: envStringOrUndefined(process.env.OPENROUTER_API_KEY),
    /** All OpenRouter credential values in rotation order (primary first). */
    credentials: credentialsFromEnv("OPENROUTER"),
    /** Model slug sent to OpenRouter. None by default — configuring one is required. */
    model: envStringOrUndefined(process.env.OPENROUTER_MODEL),
    /** OpenRouter API base URL. */
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    /** Request timeout in milliseconds (Phase 10.15 HTTP client). */
    timeoutMs: Math.max(
      1000,
      intFromEnv(process.env.OPENROUTER_TIMEOUT_MS) ?? 60_000,
    ),
  },
  /**
   * Ollama (local) provider settings (Phase 10.16).
   *
   * Local Ollama needs NO credential, so there is no key here — the adapter
   * talks to the local HTTP API with no authentication (and is therefore
   * never routed through the credential pool). The model is an operator
   * choice (`OLLAMA_MODEL`): we never assume a specific model is installed.
   */
  ollama: {
    /** Model sent to the local Ollama API. None by default — configuring one is required. */
    model: envStringOrUndefined(process.env.OLLAMA_MODEL),
    /** Local Ollama API base URL. */
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/api",
    /** Request timeout in milliseconds (Phase 10.16 HTTP client). */
    timeoutMs: Math.max(
      1000,
      intFromEnv(process.env.OLLAMA_TIMEOUT_MS) ?? 60_000,
    ),
  },
  /**
   * The name of the AI provider requested via configuration (Phase 10.10).
   * Operators set `AI_PROVIDER` to choose among the providers registered in
   * the provider-selection layer; the value is validated against the known
   * provider ids at resolution time. Defaults to the built-in Grok adapter.
   */
  aiProvider: process.env.AI_PROVIDER ?? "grok",
  /**
   * The ordered fallback chain (Phase 10.17). A comma-separated list of
   * provider ids tried in order on rotation-eligible failures. When unset,
   * the chain is just the single AI_PROVIDER (no fallback). When set,
   * the fallback list IS the chain (the first entry is primary).
   */
  aiProviderFallback: listFromEnv(process.env.AI_PROVIDER_FALLBACK) ?? [
    process.env.AI_PROVIDER ?? "grok",
  ],
  /**
   * Credential cooldown window in milliseconds (Phase 10.18). After a
   * rotation-eligible provider failure, the in-memory health component keeps
   * that credential unavailable for a fixed cooldownMs so the stacked
   * provider skips it instead of hammering it on the next call. Defaults to
   * 5 seconds; operators can tune it via `PROVIDER_COOLDOWN_MS`.
   */
  providerCooldownMs: Math.max(
    1000,
    intFromEnv(process.env.PROVIDER_COOLDOWN_MS) ?? 5_000,
  ),
};
