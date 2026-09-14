/**
 * Provider configuration validation & startup diagnostics (Phase 10.19).
 *
 * A small, deterministic, NON-THROWING diagnostics layer that inspects the
 * SAME configuration surface the composition root validates
 * (providerComposition.ts) and produces a structured, safe-to-expose report
 * for server logs or a future admin/debug endpoint.
 *
 * Why it exists, and what it deliberately does NOT do:
 *
 *   - COMPLEMENTARY TO COMPOSITION: `composeProviderStack` VALIDATES by
 *     throwing the first typed error. This layer AGGREGATES every
 *     per-provider outcome so an operator sees the whole configuration at a
 *     glance (which providers are enabled/disabled and why) rather than a
 *     single error. It never throws and never calls `composeProviderStack`.
 *   - VALIDATION ONLY: it inspects configuration strings and numbers. It
 *     performs NO provider API calls, NO health checks, NO DNS, NO network —
 *     a "valid" and "enabled" provider is NOT proof of reachability. That
 *     distinction is documented in the report semantics.
 *   - SAFE BY CONSTRUCTION: it never sees a credential VALUE (it only counts
 *     entries), never renders a real secret, never exposes an Authorization
 *     header or opaque handle, and strips any userinfo/credentials from URLs
 *     before reporting them.
 *
 * The deterministic rule: given the same (chain, settings, credentials), the
 * report is byte-for-byte identical every call — no randomness, no wall
 * clock, no IO.
 */
import {
  isProviderId,
  KNOWN_PROVIDER_IDS,
  type ProviderId as ProviderIdType,
} from "./providerSelection.js";
import type { ProviderSettings } from "./providerComposition.js";

// ---------------------------------------------------------------------------
// Safe URL rendering
// ---------------------------------------------------------------------------

/**
 * Render a base URL in a way that is SAFE to log / expose. Credentials may
 * be embedded in a URL's userinfo (e.g. `https://user:pass@host/`) — strip
 * that (and any query string, which can carry tokens) so no secret leaks.
 * Non-parseable or non-string input yields `undefined`, never a raw secret.
 */
export function safeUrlToReport(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const url = new URL(trimmed);
    // Only clean http(s) endpoints are reportable. Other schemes (e.g. a
    // "user:pass@host" string parsing under an exotic scheme like "user:")
    // can smuggle credentials in the path — refuse rather than echo.
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Not a parseable absolute URL — no reportable endpoint.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Config shape (mirrors the composition root's contract)
// ---------------------------------------------------------------------------

/**
 * The configuration surface diagnostics inspects. This is the same shape the
 * composition root validates, so a report can be produced for the identical
 * input that composes (or fails to compose) a provider stack.
 */
export interface ProviderDiagnosticsInput {
  /** Ordered fallback chain: provider ids tried in exactly this order. */
  chain: readonly string[];
  /** Per-provider settings. */
  settings: Readonly<Record<string, ProviderSettings>>;
  /** Per-provider credential value lists (counted, never revealed). */
  credentials: Readonly<Record<string, readonly string[]>>;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/** Providers that cannot operate without a credential (mirrors composition). */
const REQUIRES_CREDENTIAL: ReadonlySet<ProviderIdType> = new Set([
  "grok",
  "gemini",
  "openrouter",
]);

/**
 * A per-provider validation outcome. `enabled` is true ONLY when the provider
 * is fully valid (known id, constructible, has required model/baseUrl/timeout,
 * and — when it requires a credential — has at least one). `validationStatus`
 * carries the specific safe reason when disabled.
 */
export type ProviderConfigIssueKind =
  | "unknown-provider"
  | "duplicate-provider"
  | "missing-settings"
  | "missing-model"
  | "missing-base-url"
  | "invalid-base-url"
  | "invalid-timeout"
  | "missing-credentials"
  | "empty-order";

export interface ProviderConfigIssue {
  /** Machine-readable category (safe to match on / log). */
  code: ProviderConfigIssueKind;
  /** Short, operator-actionable, SECRET-FREE reason. */
  message: string;
}

export interface ProviderDiagnosticEntry {
  /** Provider id. */
  provider: string;
  /** Whether the provider is fully valid (true) or disabled (false). */
  enabled: boolean;
  /** The configured model, when present and safe to report. */
  model?: string;
  /** Number of configured credentials (values are NEVER included). */
  credentialCount: number;
  /** Credential-free provider (e.g. local Ollama) — no credential required. */
  credentialFree: boolean;
  /** Safe base URL/endpoint (credentials/query stripped) when present. */
  baseUrl?: string;
  /** Detailed validation outcome. */
  validationStatus: "valid" | "disabled";
  /** Safe reason(s) when disabled / invalid. */
  issues: ProviderConfigIssue[];
}

/** The full deterministic diagnostics report. */
export interface ProviderDiagnosticsReport {
  /** provider ids in configured order (deduplicated), plus unknowns. */
  providers: ProviderDiagnosticEntry[];
  /** True when the whole configuration is valid & all ordered providers enabled. */
  overallStatus: "ok" | "invalid";
  /** Every detected issue aggregated across providers (in deterministic order). */
  issues: ProviderConfigIssue[];
}

export function isValidProviderBaseUrl(value: string): boolean {
  return isValidBaseUrl(value);
}

// ---------------------------------------------------------------------------
// Per-provider credential / settings helpers
// ---------------------------------------------------------------------------

function modelOrUndefined(settings: ProviderSettings | undefined): string | undefined {
  return settings &&
    typeof settings.model === "string" &&
    settings.model.trim().length > 0
    ? settings.model
    : undefined;
}

function credentialCountFor(
  credentials: ProviderDiagnosticsInput["credentials"],
  provider: string,
): number {
  const list = credentials[provider];
  return list?.length ?? 0;
}

function isValidBaseUrl(value: string | undefined): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value.trim());
    // Only http(s) endpoints. A value like "user:pass@host:..."" parses under
    // an exotic scheme (e.g. "user:") and could smuggle credentials, so the
    // scheme AND a hostname must be present.
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.trim().length > 0
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Aggregate validation
// ---------------------------------------------------------------------------

/**
 * Produce the deterministic configuration diagnostics report for the given
 * provider configuration. NEVER throws, NEVER touches the network, NEVER
 * reveals a credential value or a secret-bearing URL.
 *
 * Semantics: a provider is `enabled: true` / `validationStatus: "valid"` only
 * when every applicable rule passes. A "valid" provider here means "the
 * configuration is sound and the provider is constructible" — it is NOT proof
 * the provider is reachable or returning healthy responses (see the header).
 */
export function validateProviderConfiguration(
  input: ProviderDiagnosticsInput,
): ProviderDiagnosticsReport {
  const entries: ProviderDiagnosticEntry[] = [];
  const issues: ProviderConfigIssue[] = [];

  if (input.chain.length === 0) {
    issues.push({
      code: "empty-order",
      message: "The provider chain is empty; at least one provider is required.",
    });
  }

  const seen = new Set<string>();
  for (const raw of input.chain) {
    const issue = validateProvider(raw, input, seen);
    entries.push(issue.entry);
    for (const item of issue.issue) issues.push(item);
    seen.add(raw);
  }

  const overallStatus =
    entries.length > 0 && entries.every((e) => e.enabled)
      ? "ok"
      : "invalid";

  return { providers: entries, overallStatus, issues };
}

interface ProviderValidationOutcome {
  entry: ProviderDiagnosticEntry;
  issue: ProviderConfigIssue[];
}

function validateProvider(
  raw: string,
  input: ProviderDiagnosticsInput,
  alreadyAdded: ReadonlySet<string>,
): ProviderValidationOutcome {
  const unresolved: ProviderConfigIssue[] = [];

  if (!isProviderId(raw)) {
    unresolved.push({
      code: "unknown-provider",
      message: `Provider "${raw}" is not a registered provider id (known: ${KNOWN_PROVIDER_IDS.join(", ")}).`,
    });
    return {
      entry: {
        provider: raw,
        enabled: false,
        credentialCount: credentialCountFor(input.credentials, raw),
        credentialFree: false,
        validationStatus: "disabled",
        issues: unresolved,
      },
      issue: unresolved,
    };
  }

  const provider: ProviderIdType = raw;

  if (alreadyAdded.has(provider)) {
    unresolved.push({
      code: "duplicate-provider",
      message: `Provider "${provider}" appears more than once in the configured order.`,
    });
  }

  const settings = input.settings[provider];
  if (settings === undefined || settings === null) {
    unresolved.push({
      code: "missing-settings",
      message: `Provider "${provider}" has no settings entry.`,
    });
  } else {
    if (typeof settings.model !== "string" || settings.model.trim().length === 0) {
      unresolved.push({ code: "missing-model", message: `Provider "${provider}" has no model configured.` });
    }
    if (typeof settings.baseUrl !== "string" || settings.baseUrl.trim().length === 0) {
      unresolved.push({ code: "missing-base-url", message: `Provider "${provider}" has no base URL configured.` });
    } else if (!isValidBaseUrl(settings.baseUrl)) {
      unresolved.push({ code: "invalid-base-url", message: `Provider "${provider}" has a malformed base URL (expected an absolute http(s) URL).` });
    }
    if (
      typeof settings.timeoutMs !== "number" ||
      !Number.isFinite(settings.timeoutMs) ||
      settings.timeoutMs <= 0
    ) {
      unresolved.push({ code: "invalid-timeout", message: `Provider "${provider}" has an invalid timeout (expected a positive number of milliseconds).` });
    }
  }

  const credentialCount = credentialCountFor(input.credentials, provider);
  const credentialFree = !REQUIRES_CREDENTIAL.has(provider);
  if (!credentialFree && credentialCount === 0) {
    unresolved.push({ code: "missing-credentials", message: `Provider "${provider}" requires at least one credential but none are configured.` });
  }

  const enabled = unresolved.length === 0;

  return {
    entry: {
      provider,
      enabled,
      model: modelOrUndefined(settings),
      credentialCount,
      credentialFree,
      baseUrl: safeUrlToReport(settings?.baseUrl),
      validationStatus: enabled ? "valid" : "disabled",
      issues: unresolved,
    },
    issue: unresolved,
  };
}