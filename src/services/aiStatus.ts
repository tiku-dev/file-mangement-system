/**
 * AI runtime status source (Phase 10.21).
 *
 * Builds the SAFE, authenticated, application-level AI provider capability
 * status consumed by `GET /api/ai/status`.
 *
 * Design rules:
 *
 *   - SINGLE CONFIG SOURCE: everything derives from the existing provider
 *     configuration diagnostics layer (`validateProviderConfiguration` over
 *     `defaultProviderCompositionOptions`). No provider configuration logic
 *     is duplicated here and no second validation pass is invented.
 *   - SECRET-FREE BY CONSTRUCTION: only the safe `ProviderDiagnosticEntry`
 *     fields are emitted. Credential VALUES and opaque credential HANDLES are
 *     never rendered, base URLs are deliberately dropped (an internal
 *     hostname/path is still configuration an app client does not need), and
 *     no environment variable names or values appear.
 *   - NO NETWORK: this is configuration status, NOT a health check. It never
 *     calls a provider adapter or `fetch`, and it never claims a configured
 *     provider is reachable — an `enabled` provider is merely fully
 *     configured and constructible (the diagnostics layer's `enabled`
 *     semantics).
 *   - STABLE: the deterministic chain order is preserved, provider "order" is
 *     the zero-based position in that chain, and repeated calls return equal
 *     output for equal configuration.
 */
import { validateProviderConfiguration } from "./providerDiagnostics.js";
import type {
  ProviderConfigIssue,
  ProviderDiagnosticsReport,
} from "./providerDiagnostics.js";
import { defaultProviderCompositionOptions } from "./providerComposition.js";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** One safe, non-secret configuration/validation reason category. */
export interface AiProviderIssue {
  /** Machine-readable reason category (safe to match on / log). */
  code: string;
  /** Short, operator-actionable, SECRET-FREE reason. */
  message: string;
}

/** Safe per-provider capability status exposed to an authenticated client. */
export interface AiProviderStatus {
  /** Provider id, e.g. "grok", "gemini", "openrouter", "ollama". */
  provider: string;
  /** Zero-based position in the configured fallback chain (deterministic). */
  order: number;
  /** Fully valid + constructible (NOT a proof of reachability). */
  enabled: boolean;
  /** Per-provider validation outcome. */
  validationStatus: "valid" | "disabled";
  /** Configured model, when present and safe to report. */
  model?: string;
  /** Number of configured credentials — never the values or handles. */
  credentialCount: number;
  /** True for credential-free providers (e.g. local Ollama). */
  credentialFree: boolean;
  /** Safe reason categories when the provider is disabled/invalid. */
  issues: AiProviderIssue[];
}

/** Stable, explicitly typed response for `GET /api/ai/status`. */
export interface AiRuntimeStatus {
  /** The status service itself computed successfully ("ok"). */
  status: "ok";
  /** Provider capability status, in configured fallback order. */
  providers: AiProviderStatus[];
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

function safeIssues(issues: readonly ProviderConfigIssue[]): AiProviderIssue[] {
  return issues.map((issue) => ({ code: issue.code, message: issue.message }));
}

/**
 * Transform a `ProviderDiagnosticsReport` into the safe, stable runtime-status
 * payload. Pure and deterministic: the same report always yields the same
 * payload. Deliberately drops `baseUrl` and never emits credential values,
 * credential handles, environment names, or filesystem paths.
 */
export function buildAiRuntimeStatus(
  report: ProviderDiagnosticsReport,
): AiRuntimeStatus {
  return {
    status: "ok",
    providers: report.providers.map((entry, order) => ({
      provider: entry.provider,
      order,
      enabled: entry.enabled,
      validationStatus: entry.validationStatus,
      ...(entry.model !== undefined && entry.model.trim().length > 0
        ? { model: entry.model }
        : {}),
      credentialCount: entry.credentialCount,
      credentialFree: entry.credentialFree,
      issues: safeIssues(entry.issues),
    })),
  };
}

/**
 * Resolve the CURRENT configured AI runtime status from the default provider
 * composition options (config/env) through the existing diagnostics source.
 *
 * @throws never for configuration — `validateProviderConfiguration` is
 *         non-throwing; any unexpected failure bubbles and is reduced by the
 *         HTTP layer's generic `internal/error` envelope (no internals leak).
 */
export function getAiRuntimeStatus(): AiRuntimeStatus {
  return buildAiRuntimeStatus(
    validateProviderConfiguration(defaultProviderCompositionOptions()),
  );
}