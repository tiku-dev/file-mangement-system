/**
 * Provider configuration validation & diagnostics tests (Phase 10.19).
 *
 * These tests exercise the deterministic, SECRET-FREE validation layer that
 * inspects the SAME configuration surface the composition root validates. It
 * never throws, never calls a provider, and never reveals a credential value
 * or a secret-bearing URL. They prove:
 *
 *   1. Valid multi-provider configuration → per-provider "valid"/enabled.
 *   2. Unknown / duplicate / missing-settings / missing-model /
 *      invalid URL & timeout / missing-credential detections.
 *   3. Credential COUNT reporting without revealing values.
 *   4. Ollama's credential-free local configuration is allowed.
 *   5. Deterministic output for identical input.
 *   6. Safe error messages and NO credential/secret leakage (including
 *      URL userinfo/query secrets being stripped).
 *   7. No network contact during validation ("valid" ≠ "reachable").
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateProviderConfiguration,
  safeUrlToReport,
  type ProviderDiagnosticsInput,
} from "./providerDiagnostics.js";
import type { ProviderSettings } from "./providerComposition.js";
import { ProviderId } from "./providerSelection.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = "super-secret-diagnostics-value";

function settings(overrides?: Partial<ProviderSettings>): ProviderSettings {
  return {
    model: "grok-3",
    baseUrl: "https://api.x.ai/v1",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function validInput(overrides?: Partial<ProviderDiagnosticsInput>): ProviderDiagnosticsInput {
  return {
    chain: [ProviderId.Grok, ProviderId.Gemini, ProviderId.Ollama],
    settings: {
      [ProviderId.Grok]: settings({ model: "grok-3" }),
      [ProviderId.Gemini]: settings({
        model: "gemini-3.5-flash",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      }),
      [ProviderId.OpenRouter]: settings({
        model: "anthropic/claude-sonnet-4",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      [ProviderId.Ollama]: settings({
        model: "qwen3",
        baseUrl: "http://localhost:11434/api",
      }),
    },
    credentials: {
      [ProviderId.Grok]: ["grok-key-1", "grok-key-2"],
      [ProviderId.Gemini]: ["gemini-key-1"],
      [ProviderId.OpenRouter]: ["openrouter-key-1"],
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Valid multi-provider configuration
// ---------------------------------------------------------------------------

describe("provider diagnostics — valid configuration", () => {
  it("reports every configured provider as enabled with a safe summary", () => {
    const report = validateProviderConfiguration(validInput());

    expect(report.overallStatus).toBe("ok");
    expect(report.issues).toEqual([]);
    expect(report.providers.map((p) => p.provider)).toEqual([
      ProviderId.Grok,
      ProviderId.Gemini,
      ProviderId.Ollama,
    ]);

    for (const entry of report.providers) {
      expect(entry.enabled).toBe(true);
      expect(entry.validationStatus).toBe("valid");
      expect(entry.issues).toEqual([]);
    }

    const grok = report.providers.find((p) => p.provider === ProviderId.Grok);
    expect(grok?.model).toBe("grok-3");
    expect(grok?.baseUrl).toBe("https://api.x.ai/v1");
  });
});

// ---------------------------------------------------------------------------
// 2. Invalid / unknown / duplicate providers
// ---------------------------------------------------------------------------

describe("provider diagnostics — order & identity validation", () => {
  it("flags an unknown provider as disabled", () => {
    const report = validateProviderConfiguration(
      validInput({ chain: ["grok", "anthropic"] }),
    );

    expect(report.overallStatus).toBe("invalid");

    const unknown = report.providers.find((p) => p.provider === "anthropic");
    expect(unknown?.enabled).toBe(false);
    expect(unknown?.validationStatus).toBe("disabled");
    expect(unknown?.issues.map((i) => i.code)).toEqual(["unknown-provider"]);
    expect(unknown?.issues[0]?.message).toContain("anthropic");
    expect(unknown?.issues[0]?.message).toContain("grok");
  });

  it("flags a duplicate provider id in the configured order", () => {
    const report = validateProviderConfiguration(
      validInput({ chain: [ProviderId.Grok, ProviderId.Grok] }),
    );

    expect(report.overallStatus).toBe("invalid");
    const duplicates = report.providers.filter(
      (p) => p.provider === ProviderId.Grok && p.issues.some((i) => i.code === "duplicate-provider"),
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.enabled).toBe(false);
    expect(duplicates[0]?.issues[0]?.message).toContain("more than once");
  });

  it("reports an empty chain as invalid with a clear issue", () => {
    const report = validateProviderConfiguration(validInput({ chain: [] }));

    expect(report.overallStatus).toBe("invalid");
    expect(report.providers).toEqual([]);
    expect(report.issues.map((i) => i.code)).toEqual(["empty-order"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing settings / credential requirements
// ---------------------------------------------------------------------------

describe("provider diagnostics — settings & credentials", () => {
  it("flags a provider with no settings entry", () => {
    const settings = { ...validInput().settings };
    delete settings[ProviderId.Gemini];
    const report = validateProviderConfiguration(
      validInput({
        settings,
      }),
    );

    const gemini = report.providers.find((p) => p.provider === ProviderId.Gemini);
    expect(gemini?.enabled).toBe(false);
    expect(gemini?.issues.map((i) => i.code)).toContain("missing-settings");
  });

  it("flags a missing required model", () => {
    const report = validateProviderConfiguration(
      validInput({
        settings: {
          ...validInput().settings,
          [ProviderId.Grok]: settings({ model: "   " }),
        },
      }),
    );

    const grok = report.providers.find((p) => p.provider === ProviderId.Grok);
    expect(grok?.enabled).toBe(false);
    expect(grok?.issues.map((i) => i.code)).toEqual(["missing-model"]);
    expect(grok?.model).toBeUndefined();
  });

  it("flags a provider that requires a credential but has none", () => {
    const report = validateProviderConfiguration(
      validInput({ credentials: {} }),
    );

    const grok = report.providers.find((p) => p.provider === ProviderId.Grok);
    expect(grok?.enabled).toBe(false);
    expect(grok?.issues.map((i) => i.code)).toContain("missing-credentials");

    // Ollama is credential-free: it stays valid even with no credentials.
    const ollama = report.providers.find((p) => p.provider === ProviderId.Ollama);
    expect(ollama?.enabled).toBe(true);
    expect(ollama?.credentialFree).toBe(true);
  });

  it("allows Ollama's credential-free local configuration", () => {
    const ollamaOnly = validInput({
      chain: [ProviderId.Ollama],
      credentials: {},
      settings: {
        [ProviderId.Ollama]: settings({
          model: "qwen3",
          baseUrl: "http://localhost:11434/api",
        }),
      },
    });
    const report = validateProviderConfiguration(ollamaOnly);

    expect(report.overallStatus).toBe("ok");
    const ollama = report.providers[0];
    expect(ollama?.provider).toBe(ProviderId.Ollama);
    expect(ollama?.enabled).toBe(true);
    expect(ollama?.credentialFree).toBe(true);
    expect(ollama?.credentialCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Credential count reporting (no values)
// ---------------------------------------------------------------------------

describe("provider diagnostics — credential counts", () => {
  it("reports credential counts per provider WITHOUT revealing values", () => {
    const report = validateProviderConfiguration(
      validInput({
        credentials: {
          [ProviderId.Grok]: [`${SECRET}-1`, `${SECRET}-2`],
          [ProviderId.Gemini]: [`${SECRET}-gemini`],
        },
      }),
    );

    const grok = report.providers.find((p) => p.provider === ProviderId.Grok);
    expect(grok?.credentialCount).toBe(2);
    const gemini = report.providers.find((p) => p.provider === ProviderId.Gemini);
    expect(gemini?.credentialCount).toBe(1);
    const ollama = report.providers.find((p) => p.provider === ProviderId.Ollama);
    expect(ollama?.credentialCount).toBe(0);

    // No credential value anywhere in the serialized report.
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed configuration / invalid URL / invalid timeout
// ---------------------------------------------------------------------------

describe("provider diagnostics — malformed configuration", () => {
  it("flags missing and malformed base URLs", () => {
    const missingUrl = validateProviderConfiguration(
      validInput({
        settings: {
          ...validInput().settings,
          [ProviderId.Grok]: settings({ baseUrl: "" }),
        },
      }),
    );
    const grokMissing = missingUrl.providers.find((p) => p.provider === ProviderId.Grok);
    expect(grokMissing?.enabled).toBe(false);
    expect(grokMissing?.issues.map((i) => i.code)).toContain("missing-base-url");
    expect(grokMissing?.baseUrl).toBeUndefined();

    const malformedUrl = validateProviderConfiguration(
      validInput({
        settings: {
          ...validInput().settings,
          [ProviderId.Grok]: settings({ baseUrl: "not-a-url" }),
        },
      }),
    );
    const grokBad = malformedUrl.providers.find((p) => p.provider === ProviderId.Grok);
    expect(grokBad?.enabled).toBe(false);
    expect(grokBad?.issues.map((i) => i.code)).toContain("invalid-base-url");
  });

  it("flags invalid timeouts", () => {
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const report = validateProviderConfiguration(
        validInput({
          settings: {
            ...validInput().settings,
            [ProviderId.Grok]: settings({ timeoutMs }),
          },
        }),
      );
      const grok = report.providers.find((p) => p.provider === ProviderId.Grok);
      expect(grok?.enabled).toBe(false);
      expect(grok?.issues.map((i) => i.code)).toContain("invalid-timeout");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

describe("provider diagnostics — determinism", () => {
  it("produces an identical report for identical input", () => {
    const input = validInput();
    const a = validateProviderConfiguration(input);
    const b = validateProviderConfiguration(input);
    expect(a).toEqual(b);

    const broken = validInput({ chain: [ProviderId.Grok, "nope", ProviderId.Grok] });
    const c = validateProviderConfiguration(broken);
    const d = validateProviderConfiguration(broken);
    expect(c).toEqual(d);
  });
});

// ---------------------------------------------------------------------------
// 7. Safe error messages & no leakage
// ---------------------------------------------------------------------------

describe("provider diagnostics — safety", () => {
  it("never exposes credential values or opaque handles", () => {
    const report = validateProviderConfiguration(
      validInput({
        chain: [ProviderId.Grok, "anthropic", ProviderId.Grok],
        credentials: {
          [ProviderId.Grok]: ["grok-secret-1", "grok-secret-2"],
          [ProviderId.Gemini]: ["gemini-secret-1"],
        },
      }),
    );

    const text = JSON.stringify(report);
    expect(text).not.toContain("grok-secret-1");
    expect(text).not.toContain("grok-secret-2");
    expect(text).not.toContain("gemini-secret-1");
    expect(text).not.toContain("credential-"); // no opaque credential IDs either
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("Bearer");
  });

  it("strips credentials and query strings from reported URLs", () => {
    // A URL carrying userinfo credentials and a query-secret must be sanitized.
    expect(
      safeUrlToReport("https://user:pass@api.example.com/v1?token=abc"),
    ).toBe("https://api.example.com/v1");
    expect(safeUrlToReport("https://api.example.com/v1?apikey=secret")).toBe(
      "https://api.example.com/v1",
    );
    // Plain, safe URLs pass through.
    expect(safeUrlToReport("https://api.x.ai/v1")).toBe("https://api.x.ai/v1");
  });

  it("omits base URLs that could smuggle a secret", () => {
    const report = validateProviderConfiguration(
      validInput({
        settings: {
          ...validInput().settings,
          [ProviderId.Grok]: settings({
            baseUrl: "https://user:pass@api.x.ai/v1?token=abc",
          }),
        },
      }),
    );

    const grok = report.providers.find((p) => p.provider === ProviderId.Grok);
    expect(grok?.baseUrl).toBe("https://api.x.ai/v1");
    expect(JSON.stringify(report)).not.toContain("user");
    expect(JSON.stringify(report)).not.toContain("pass");
    expect(JSON.stringify(report)).not.toContain("token=abc");
  });

  it("flags malformed base URLs instead of echoing a raw secret", () => {
    const report = validateProviderConfiguration(
      validInput({
        settings: {
          ...validInput().settings,
          [ProviderId.Grok]: settings({ baseUrl: "user:pass@host:not-a-url" }),
        },
      }),
    );
    const grok = report.providers.find((p) => p.provider === ProviderId.Grok);
    expect(grok?.enabled).toBe(false);
    // The URL is malformed (unparseable) -> valid parse fails -> issue.
    expect(grok?.issues.map((i) => i.code)).toContain("invalid-base-url");
    // The raw secret-laden string is NOT echoed.
    expect(JSON.stringify(report)).not.toContain("user:pass");
  });
});

// ---------------------------------------------------------------------------
// 8. No network contact
// ---------------------------------------------------------------------------

describe("provider diagnostics — no network contact", () => {
  it("never issues a request while validating", () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      async () => {
        fetchCalls += 1;
        throw new Error("network forbidden during diagnostics");
      },
    );

    const report = validateProviderConfiguration(validInput());
    // Break URL reporting too: sanity that safeUrlToReport also does no IO.
    safeUrlToReport("https://api.example.com/v1");

    expect(report.overallStatus).toBe("ok");
    expect(fetchCalls).toBe(0);
  });
});