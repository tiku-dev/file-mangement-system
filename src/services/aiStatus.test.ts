/**
 * AI runtime status tests (Phase 10.21).
 *
 * These tests exercise the safe-status PIPELINE that backs
 * `GET /api/ai/status`: the real provider configuration diagnostics source
 * (`validateProviderConfiguration`) feeding the stable payload transform
 * (`buildAiRuntimeStatus`) and the config-bound resolver
 * (`getAiRuntimeStatus`). Everything is deterministic and NO network is used.
 *
 * Coverage:
 *
 *   1. Deterministic provider ordering across a multi-provider chain.
 *   2. Enabled / valid status for fully configured providers, incl. model.
 *   3. Credential COUNT reported — values and handles never leaked.
 *   4. Credential-free providers (Ollama) identified correctly.
 *   5. Disabled / invalid status with safe reason categories.
 *   6. Unknown / duplicate providers flagged safely.
 *   7. Model omitted when absent.
 *   8. No base-URL / env / filesystem-path leakage.
 *   9. No network request performed.
 *  10. Stable, explicitly typed response shape.
 *  11. `getAiRuntimeStatus()` resolves deterministically from config.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateProviderConfiguration,
  type ProviderDiagnosticsInput,
} from "./providerDiagnostics.js";
import type { ProviderSettings } from "./providerComposition.js";
import {
  buildAiRuntimeStatus,
  getAiRuntimeStatus,
  type AiProviderStatus,
  type AiRuntimeStatus,
} from "./aiStatus.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROK_KEY_1 = "groK-teL-X9SecretApiKey-\u00e9n731";
const GROK_KEY_2 = "second-grok-secret-2";
const GEMINI_KEY = "gemini-secret";
const OLLAMA_KEY = "ollama-has-no-credential";

function settings(overrides?: Partial<ProviderSettings>): ProviderSettings {
  return {
    model: "grok-3",
    baseUrl: "https://api.x.ai/v1",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function makeInput(overrides?: Partial<ProviderDiagnosticsInput>): ProviderDiagnosticsInput {
  return {
    chain: ["grok", "gemini", "ollama"],
    settings: {
      grok: settings(),
      gemini: settings({ model: "gemini-3.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
      ollama: settings({ model: "qwen3", baseUrl: "http://localhost:11434/api" }),
    },
    credentials: {
      grok: [GROK_KEY_1, GROK_KEY_2],
      gemini: [GEMINI_KEY],
      ollama: [OLLAMA_KEY],
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1 & 2. Ordering + enabled/valid status
// ---------------------------------------------------------------------------

describe("buildAiRuntimeStatus — ordering and validity", () => {
  it("preserves the configured fallback order with stable zero-based order", () => {
    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(makeInput({ chain: ["ollama", "grok", "gemini"] })),
    );

    expect(payload.status).toBe("ok");
    expect(payload.providers.map((p) => p.provider)).toEqual(["ollama", "grok", "gemini"]);
    expect(payload.providers.map((p) => p.order)).toEqual([0, 1, 2]);
  });

  it("reports enabled + valid with model and credential count", () => {
    const payload = buildAiRuntimeStatus(validateProviderConfiguration(makeInput()));

    const grok = payload.providers[0]!;
    expect(grok).toMatchObject({
      provider: "grok",
      enabled: true,
      validationStatus: "valid",
      credentialCount: 2,
      credentialFree: false,
      model: "grok-3",
      issues: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Credential count, never values or handles
// ---------------------------------------------------------------------------

describe("buildAiRuntimeStatus — credential containment", () => {
  it("reports credential counts without ever leaking values", () => {
    const payload = buildAiRuntimeStatus(validateProviderConfiguration(makeInput()));
    const grok = payload.providers[0]!;
    expect(grok.credentialCount).toBe(2);
    expect(grok.credentialFree).toBe(false);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(GROK_KEY_1);
    expect(serialized).not.toContain(GROK_KEY_2);
    expect(serialized).not.toContain(GEMINI_KEY);
  });

  it("never leaks opaque credential handles (e.g. credential-1)", () => {
    const payload = buildAiRuntimeStatus(validateProviderConfiguration(makeInput()));
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("credential-1");
    expect(serialized).not.toContain("credential-2");
    expect(serialized).not.toContain("credential-");
  });
});

// ---------------------------------------------------------------------------
// 4. Credential-free providers
// ---------------------------------------------------------------------------

describe("buildAiRuntimeStatus — credential-free providers", () => {
  it("identifies local Ollama as credential-free even when idempotent", () => {
    // Even though the fixture lists an ollama "credential", the provider is
    // credential-free by design; the payload must say so.
    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(makeInput({ chain: ["ollama"] })),
    );

    const ollama = payload.providers[0]!;
    expect(ollama.credentialFree).toBe(true);
    expect(ollama.credentialCount).toBe(1); // counted, but never relevant to enablement
    expect(ollama.enabled).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(OLLAMA_KEY);
  });

  it("reports a credential-free provider with zero credentials as enabled", () => {
    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(
        makeInput({ chain: ["ollama"], credentials: { grok: [], gemini: [], ollama: [] } }),
      ),
    );

    expect(payload.providers[0]).toMatchObject({
      provider: "ollama",
      credentialFree: true,
      credentialCount: 0,
      enabled: true,
      validationStatus: "valid",
    });
  });
});

// ---------------------------------------------------------------------------
// 5 & 6. Disabled / invalid + reason categories
// ---------------------------------------------------------------------------

describe("buildAiRuntimeStatus — disabled and invalid status", () => {
  it("flags a credential-requiring provider without credentials as disabled", () => {
    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(
        makeInput({ credentials: { grok: [], gemini: [GEMINI_KEY], ollama: [] } }),
      ),
    );

    const grok = payload.providers[0]!;
    expect(grok.enabled).toBe(false);
    expect(grok.validationStatus).toBe("disabled");
    expect(grok.credentialCount).toBe(0);
    expect(grok.issues.map((i) => i.code)).toContain("missing-credentials");
  });

  it("reports safe reason categories with secret-free messages", () => {
    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(
        makeInput({ chain: ["grok"], credentials: { grok: [] } }),
      ),
    );

    const grok = payload.providers[0]!;
    expect(grok.issues).toEqual([
      { code: "missing-credentials", message: `Provider "grok" requires at least one credential but none are configured.` },
    ]);
  });

  it("flags unknown providers safely", () => {
    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(makeInput({ chain: ["ghost-provider"] })),
    );

    const ghost = payload.providers[0]!;
    expect(ghost.provider).toBe("ghost-provider");
    expect(ghost.enabled).toBe(false);
    expect(ghost.validationStatus).toBe("disabled");
    expect(ghost.issues.map((i) => i.code)).toEqual([expect.stringMatching(/unknown-provider/)]);
  });

  it("flags duplicate providers while preserving both entries", () => {
    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(makeInput({ chain: ["grok", "grok"] })),
    );

    expect(payload.providers).toHaveLength(2);
    expect(payload.providers[1]!.issues.map((i) => i.code)).toContain("duplicate-provider");
  });

  it("omits the model field when absent", () => {
    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(
        makeInput({ settings: { grok: settings({ model: "" }), gemini: settings(), ollama: settings() } }),
      ),
    );

    expect("model" in payload.providers[0]!).toBe(false);
    expect(payload.providers[0]!.issues.map((i) => i.code)).toContain("missing-model");
  });
});

// ---------------------------------------------------------------------------
// 8. No base-URL / env / filesystem-path leakage
// ---------------------------------------------------------------------------

describe("buildAiRuntimeStatus — no endpoint/path leakage", () => {
  it("never emits base URLs even when they carry secrets", () => {
    const secretUrl =
      "https://user:superSecretPass@internal-ai-02.service:8443/api/gateway?token=abc123#frag";

    const payload = buildAiRuntimeStatus(
      validateProviderConfiguration(
        makeInput({
          chain: ["grok"],
          settings: { grok: settings({ baseUrl: secretUrl }) },
          credentials: { grok: [GROK_KEY_1] },
        }),
      ),
    );

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("internal-ai-02");
    expect(serialized).not.toContain("service");
    expect(serialized).not.toContain("superSecretPass");
    expect(serialized).not.toContain("api/gateway");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("/api/");
  });

  it("never leaks environment-variable-shaped names or filesystem paths", () => {
    const payload = buildAiRuntimeStatus(validateProviderConfiguration(makeInput()));

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("GROK_API_KEY");
    expect(serialized).not.toContain("AI_PROVIDER");
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("C:\\\\");
    expect(serialized).not.toContain("/usr/");
    expect(serialized).not.toContain("/backend/src/");
  });
});

// ---------------------------------------------------------------------------
// 9. No network
// ---------------------------------------------------------------------------

describe("buildAiRuntimeStatus / getAiRuntimeStatus — no network", () => {
  it("performs no network request when building from a report", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    buildAiRuntimeStatus(validateProviderConfiguration(makeInput()));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it("performs no network request when resolving from configuration", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    getAiRuntimeStatus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10 & 11. Stable shape + config resolver
// ---------------------------------------------------------------------------

describe("aiRuntimeStatus — stable shape and config resolver", () => {
  it("has the exact stable response shape", () => {
    const payload = buildAiRuntimeStatus(validateProviderConfiguration(makeInput()));

    expect(Object.keys(payload).sort()).toEqual(["providers", "status"]);
    expect(payload.status).toBe("ok");

    for (const provider of payload.providers) {
      expect(Object.keys(provider).sort()).toEqual(
        ["credentialCount", "credentialFree", "enabled", "issues", "model", "order", "provider", "validationStatus"].sort(),
      );
      expect(typeof provider.provider).toBe("string");
      expect(typeof provider.order).toBe("number");
      expect(typeof provider.enabled).toBe("boolean");
      expect(["valid", "disabled"]).toContain(provider.validationStatus);
      expect(typeof provider.credentialCount).toBe("number");
      expect(typeof provider.credentialFree).toBe("boolean");
      expect(Array.isArray(provider.issues)).toBe(true);
      for (const issue of provider.issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "message"]);
      }
    }
  });

  it("getAiRuntimeStatus is deterministic and stays secret-free", () => {
    const first = getAiRuntimeStatus();
    const second = getAiRuntimeStatus();

    expect(second).toEqual(first);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("credential-");
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("GROK_API_KEY");
    expect(first.providers.every((p) => p.order === first.providers.indexOf(p))).toBe(true);
  });

  it("every exposed provider preserves a stable shape consumed by the route", () => {
    const payload: AiRuntimeStatus = getAiRuntimeStatus();
    const providers: AiProviderStatus[] = payload.providers;
    expect(providers.length).toBeGreaterThan(0);
  });
});