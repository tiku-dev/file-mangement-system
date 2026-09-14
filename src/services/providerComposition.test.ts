/**
 * Provider composition root tests (Phase 10.17).
 *
 * These tests exercise the single composition/configuration boundary for the
 * AI provider system. The HTTP transport is MOCKED via `vi.stubGlobal` —
 * no real provider API and no network traffic. They prove the composition:
 *
 *   1. Loads default/configured provider settings and fallback order.
 *   2. Validates the chain and per-provider configuration, failing clearly
 *      at composition time for empty / unknown / duplicate chains, invalid
 *      settings, missing required models, and missing required credentials.
 *   3. Registers ordered credentials (and the no-credential local path) into
 *      the real CredentialPool.
 *   4. Constructs the real adapters ONLY through the build hook, wiring the
 *      pool + rotation through the fallback layer.
 *   5. Stays deterministic and keeps the Agent unaware (a plain
 *      AgentProvider) with credentials never leaking into errors, responses,
 *      or the facade.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import {
  composeProviderStack,
  defaultProviderCompositionOptions,
  isProviderCompositionError,
  ProviderCompositionError,
  type ProviderCompositionOptions,
  type ProviderSettings,
} from "./providerComposition.js";
import {
  isProviderError,
  ProviderError,
  ProviderErrorCode,
  type AgentProvider,
  type AgentResponse,
} from "./provider.js";
import { ProviderFallbackError } from "./providerFallback.js";
import { CredentialPoolError } from "./credentialPool.js";
import { ProviderId } from "./providerSelection.js";
import { createProviderHealth } from "./providerHealth.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function settings(overrides?: Partial<ProviderSettings>): ProviderSettings {
  return {
    model: "grok-3",
    baseUrl: "https://api.x.ai/v1",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function makeOptions(
  overrides?: Partial<ProviderCompositionOptions>,
): ProviderCompositionOptions {
  return {
    chain: [ProviderId.Grok],
    settings: {
      [ProviderId.Grok]: settings(),
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

function fakeProvider(text = "fake reply"): AgentProvider {
  return {
    generate: vi
      .fn<AgentProvider["generate"]>()
      .mockResolvedValue({ text } satisfies AgentResponse),
  };
}

// A minimal response-shaped object the adapters consume.
function makeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

type CapturedRequest = {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  };
};

/**
 * Install a mocked global `fetch` driven by a QUEUE of steps. Each step
 * returns a response-shaped object or throws (connection failure). Records
 * every request (including the Authorization header) for assertions.
 */
function stubFetchQueue(
  steps: Array<() => unknown>,
): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  let index = 0;
  const fetch = async (input: string, init: unknown) => {
    captured.push({
      url: String(input),
      init: init as CapturedRequest["init"],
    });
    const step = steps[index];
    index += 1;
    if (step === undefined) {
      throw new Error("test stub received an unexpected extra request");
    }
    return step();
  };
  vi.stubGlobal("fetch", fetch);
  return { captured };
}

/** A step that throws a provider-level connection failure (rotates). */
function failWithUnavailable(): () => never {
  return () => {
    throw ProviderError.transient(
      ProviderErrorCode.Unavailable,
      "simulated provider outage",
    );
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectCompositionFailure(
  fn: () => unknown,
  code: ProviderCompositionError["code"],
  provider?: string,
): void {
  try {
    fn();
    expect.unreachable("composition must throw synchronously");
  } catch (error) {
    expect(isProviderCompositionError(error)).toBe(true);
    const err = error as ProviderCompositionError;
    expect(err.code).toBe(code);
    if (provider !== undefined) expect(err.providerId).toBe(provider);
  }
}

// ---------------------------------------------------------------------------
// 1. Default provider configuration
// ---------------------------------------------------------------------------

describe("default provider configuration", () => {
  it("loads the configured fallback chain and per-provider settings from config", () => {
    const options = defaultProviderCompositionOptions();

    // The chain is the configured fallback (defaults to the single provider).
    expect(options.chain).toEqual(config.aiProviderFallback);
    // Settings mirror the environment-driven config exactly.
    expect(options.settings[ProviderId.Grok]).toEqual({
      model: config.grok.model,
      baseUrl: config.grok.baseUrl,
      timeoutMs: config.grok.timeoutMs,
    });
    expect(options.settings[ProviderId.Gemini]).toEqual({
      model: config.gemini.model,
      baseUrl: config.gemini.baseUrl,
      timeoutMs: config.gemini.timeoutMs,
    });
    expect(options.settings[ProviderId.OpenRouter]).toEqual({
      model: config.openrouter.model ?? "",
      baseUrl: config.openrouter.baseUrl,
      timeoutMs: config.openrouter.timeoutMs,
    });
    // Credentials come from the configured key lists.
    expect(options.credentials[ProviderId.Grok]).toEqual(
      config.grok.credentials,
    );
    // Environments (like the default test env) without a key yield an empty
    // list — the composition then fails clearly (see missing-credentials).
    expect(typeof options.credentials[ProviderId.Grok]?.length).toBe("number");
  });

  it("composes the default configuration once credentials are configured", async () => {
    const options = defaultProviderCompositionOptions();
    options.chain = [ProviderId.Grok];
    options.credentials = {
      ...options.credentials,
      [ProviderId.Grok]: ["grok-key-1"],
    };
    const { captured } = stubFetchQueue([
      () => makeResponse({ choices: [{ message: { content: "hi" } }] }),
    ]);

    const stack = composeProviderStack(options);
    const response = await stack.provider.generate({
      message: "hello",
      tools: [],
    });

    expect(response).toEqual({ text: "hi" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.init.headers.Authorization).toBe("Bearer grok-key-1");
  });
});

// ---------------------------------------------------------------------------
// 2. Custom provider ordering
// ---------------------------------------------------------------------------

describe("custom provider ordering", () => {
  it("honors the configured fallback order and classifies providers", () => {
    const stack = composeProviderStack(
      makeOptions({ chain: [ProviderId.Ollama, ProviderId.Grok] }),
    );

    expect(stack.chain).toEqual([ProviderId.Ollama, ProviderId.Grok]);
    expect(stack.credentialFreeProviders).toEqual([ProviderId.Ollama]);
    expect(stack.credentialProviders).toEqual([ProviderId.Grok]);
  });

  it("tries providers in the configured order", async () => {
    // Single credential per provider; the first (Ollama) fails as unavailable
    // so the second (Gemini) answers. Order proves the chain is honored.
    const { captured } = stubFetchQueue([
      failWithUnavailable(),
      () =>
        makeResponse({
          candidates: [{ content: { parts: [{ text: "from gemini" }] } }],
        }),
    ]);
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Ollama, ProviderId.Gemini],
        credentials: { [ProviderId.Gemini]: ["gemini-key-1"] },
      }),
    );

    const response = await stack.provider.generate({
      message: "x",
      tools: [],
    });

    expect(response).toEqual({ text: "from gemini" });
    const urls = captured.map((c) => c.url);
    // First the local Ollama endpoint, then Gemini.
    expect(urls[0]).toBe("http://localhost:11434/api/chat");
    expect(urls[1]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Multiple credentials per provider + registration
// ---------------------------------------------------------------------------

describe("credential registration", () => {
  it("registers multiple credentials per provider in order", () => {
    const stack = composeProviderStack(
      makeOptions({
        credentials: {
          [ProviderId.Grok]: ["key-a", "key-b", "key-c"],
        },
      }),
    );

    const handles = stack.credentials.all(ProviderId.Grok);
    expect(handles.map((h) => h.id)).toEqual([
      "credential-1",
      "credential-2",
      "credential-3",
    ]);
    expect(stack.credentials.reveal(stack.credentials.obtain(ProviderId.Grok))).toBe(
      "key-a",
    );
  });

  it("registers credentials only for providers in the configured chain", () => {
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Grok],
        credentials: {
          [ProviderId.Grok]: ["grok-key-1", "grok-key-2"],
          [ProviderId.Gemini]: ["unused-gemini-key"],
          [ProviderId.OpenRouter]: ["unused-openrouter-key"],
        },
      }),
    );

    expect(stack.credentials.all(ProviderId.Grok)).toHaveLength(2);
    expect(stack.credentials.has(ProviderId.Gemini)).toBe(false);
    expect(stack.credentials.has(ProviderId.OpenRouter)).toBe(false);
    // Registration order is deterministic (same options → same stack).
    const again = composeProviderStack({
      ...makeOptions({
        chain: [ProviderId.Grok],
        credentials: {
          [ProviderId.Grok]: ["grok-key-1", "grok-key-2"],
          [ProviderId.Gemini]: ["unused-gemini-key"],
        },
      }),
    });
    expect(again.credentials.all(ProviderId.Grok).map((h) => h.id)).toEqual([
      "credential-1",
      "credential-2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Ollama's no-credential local path
// ---------------------------------------------------------------------------

describe("Ollama with no credentials", () => {
  it("composes a credential-free Ollama provider and attempts it locally", async () => {
    const { captured } = stubFetchQueue([
      () =>
        makeResponse({
          message: { role: "assistant", content: "local reply" },
        }),
    ]);
    const stack = composeProviderStack(
      makeOptions({ chain: [ProviderId.Ollama] }),
    );

    expect(stack.credentialFreeProviders).toEqual([ProviderId.Ollama]);
    expect(stack.credentialProviders).toEqual([]);
    // Exactly ONE credential-free pool slot so the unchanged fallback layer
    // tries the provider exactly once — the slot carries no secret and can
    // never be revealed as a key.
    expect(stack.credentials.all(ProviderId.Ollama)).toHaveLength(1);
    expect(() =>
      stack.credentials.reveal(stack.credentials.obtain(ProviderId.Ollama)),
    ).toThrowError(CredentialPoolError);

    const response = await stack.provider.generate({ message: "x", tools: [] });

    expect(response).toEqual({ text: "local reply" });
    const call = captured[0];
    expect(call?.url).toBe("http://localhost:11434/api/chat");
    // The local request carries NO credential: no Authorization header, and
    // the request body contains no key material.
    expect(call?.init.headers.Authorization).toBeUndefined();
    expect(Object.keys(call?.init.headers ?? {})).toEqual(["Content-Type"]);
    expect(JSON.stringify(call?.init.body ?? "")).not.toContain(
      "__credential_free__",
    );
  });

  it("constructs the Ollama adapter with no credential value at all", async () => {
    // The factory seam receives `undefined` for a credential-free provider —
    // never the free slot (which the pool refuses to reveal anyway).
    stubFetchQueue([
      () =>
        makeResponse({
          message: { role: "assistant", content: "local reply" },
        }),
    ]);
    const factory = vi
      .fn()
      .mockImplementation(
        (_provider: string, _s: ProviderSettings, _value: string | undefined) =>
          fakeProvider("from injected factory for ollama"),
      );
    const stack = composeProviderStack({
      ...makeOptions({ chain: [ProviderId.Ollama] }),
      adapterFactory: factory,
    });

    const response = await stack.provider.generate({ message: "x", tools: [] });

    expect(response).toEqual({ text: "from injected factory for ollama" });
    expect(factory).toHaveBeenCalledWith(
      ProviderId.Ollama,
      expect.objectContaining({ model: "qwen3" }),
      undefined,
    );
  });

  it("never exposes the removed placeholder string anywhere in the surface", async () => {
    const SENTINEL = "__credential_free__";
    stubFetchQueue([
      () =>
        makeResponse({
          message: { role: "assistant", content: "ok" },
        }),
    ]);
    const stack = composeProviderStack(
      makeOptions({ chain: [ProviderId.Ollama] }),
    );

    const response = await stack.provider.generate({ message: "x", tools: [] });

    // Not in the facade, the pool surface, the response, or the request.
    expect(JSON.stringify(stack.provider)).not.toContain(SENTINEL);
    expect(JSON.stringify(stack.credentials.all(ProviderId.Ollama))).not.toContain(
      SENTINEL,
    );
    expect(JSON.stringify(response)).not.toContain(SENTINEL);
  });

  it("rotation advances the free slot without ever turning it into a key", async () => {
    // Ollama is unavailable first (Unavailable → rotate-eligible), so the
    // fallback rotates its single free slot and moves to Grok.
    const { captured } = stubFetchQueue([
      failWithUnavailable(),
      () => makeResponse({ choices: [{ message: { content: "from grok" } }] }),
    ]);
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Ollama, ProviderId.Grok],
        credentials: { [ProviderId.Grok]: ["grok-key-1"] },
      }),
    );

    const response = await stack.provider.generate({ message: "x", tools: [] });

    expect(response).toEqual({ text: "from grok" });
    expect(captured).toHaveLength(2);
    // The local attempt carried no credential; Grok used its own.
    expect(captured[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(captured[0]?.init.headers.Authorization).toBeUndefined();
    expect(captured[1]?.init.headers.Authorization).toBe("Bearer grok-key-1");
    // After rotation the free slot is unchanged: still one entry, still a
    // non-secret that reveal refuses.
    expect(stack.credentials.all(ProviderId.Ollama)).toHaveLength(1);
    expect(() =>
      stack.credentials.reveal(stack.credentials.obtain(ProviderId.Ollama)),
    ).toThrowError(CredentialPoolError);
  });

  it("exhaustion of the credential-free path reports ids, never a secret", async () => {
    const { captured } = stubFetchQueue([failWithUnavailable()]);
    const stack = composeProviderStack(
      makeOptions({ chain: [ProviderId.Ollama] }),
    );

    try {
      await stack.provider.generate({ message: "x", tools: [] });
      expect.unreachable("single credential-free provider must exhaust");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFallbackError);
      const err = error as ProviderFallbackError;
      // The summary names provider + the free slot's deterministic id — the
      // removed sentinel string and any secret-shaped value stay absent.
      expect(err.attempted).toEqual([
        expect.objectContaining({
          provider: ProviderId.Ollama,
          credentialId: "credential-1",
          code: ProviderErrorCode.Unavailable,
        }),
      ]);
      expect(JSON.stringify(err.attempted)).not.toContain("__credential_free__");
      expect(err.message).not.toContain("__credential_free__");
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]?.init.headers.Authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Validation failures
// ---------------------------------------------------------------------------

describe("required credential missing", () => {
  it("fails clearly for a credential-requiring provider with no credentials", () => {
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            chain: [ProviderId.Grok],
            credentials: { [ProviderId.Grok]: [] },
          }),
        ),
      "provider-composition/missing-credentials",
      ProviderId.Grok,
    );
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            chain: [ProviderId.OpenRouter],
            credentials: { [ProviderId.OpenRouter]: [] },
          }),
        ),
      "provider-composition/missing-credentials",
      ProviderId.OpenRouter,
    );
  });

  it("fails clearly when a credential-requiring provider has no entry at all", () => {
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            chain: [ProviderId.Gemini],
            credentials: {},
          }),
        ),
      "provider-composition/missing-credentials",
      ProviderId.Gemini,
    );
  });
});

describe("required model missing", () => {
  it("fails clearly when a provider has an empty model", () => {
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            chain: [ProviderId.OpenRouter],
            settings: {
              ...makeOptions().settings,
              [ProviderId.OpenRouter]: settings({ model: "" }),
            },
          }),
        ),
      "provider-composition/missing-model",
      ProviderId.OpenRouter,
    );
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            chain: [ProviderId.Ollama],
            settings: {
              ...makeOptions().settings,
              [ProviderId.Ollama]: settings({
                model: "",
                baseUrl: "http://localhost:11434/api",
              }),
            },
          }),
        ),
      "provider-composition/missing-model",
      ProviderId.Ollama,
    );
  });
});

describe("invalid / unknown provider configuration", () => {
  it("fails clearly for an unknown provider id in the chain", () => {
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({ chain: ["grok", "anthropic"] }),
        ),
      "provider-composition/unknown-provider",
      "anthropic",
    );
    // The message lists the known ids so operators can fix the value.
    try {
      composeProviderStack(makeOptions({ chain: ["anthropic"] }));
      expect.unreachable("unknown provider must throw");
    } catch (error) {
      const err = error as ProviderCompositionError;
      expect(err.message).toContain("anthropic");
      expect(err.message).toContain("grok");
      // A configuration error is NOT an external provider failure.
      expect(isProviderError(err)).toBe(false);
    }
  });

  it("fails clearly for an empty fallback chain", () => {
    expectCompositionFailure(
      () => composeProviderStack(makeOptions({ chain: [] })),
      "provider-composition/empty-order",
    );
  });

  it("fails clearly for a duplicate provider id in the chain", () => {
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            chain: ["grok", "grok"],
            credentials: { [ProviderId.Grok]: ["key"] },
          }),
        ),
      "provider-composition/duplicate-provider",
      ProviderId.Grok,
    );
  });

  it("fails clearly for a chain provider with no settings entry", () => {
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            chain: [ProviderId.Grok],
            settings: {},
          }),
        ),
      "provider-composition/missing-settings",
      ProviderId.Grok,
    );
  });

  it("fails clearly for a malformed timeout", () => {
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            settings: {
              ...makeOptions().settings,
              [ProviderId.Grok]: settings({ timeoutMs: 0 }),
            },
          }),
        ),
      "provider-composition/invalid-configuration",
      ProviderId.Grok,
    );
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            settings: {
              ...makeOptions().settings,
              [ProviderId.Grok]: settings({ timeoutMs: Number.NaN }),
            },
          }),
        ),
      "provider-composition/invalid-configuration",
      ProviderId.Grok,
    );
  });

  it("fails clearly for an invalid (empty) base URL", () => {
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            settings: {
              ...makeOptions().settings,
              [ProviderId.Grok]: settings({ baseUrl: "  " }),
            },
          }),
        ),
      "provider-composition/invalid-configuration",
      ProviderId.Grok,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Provider construction + injection seam
// ---------------------------------------------------------------------------

describe("provider construction", () => {
  it("constructs the real adapter through the build hook and answers", async () => {
    const { captured } = stubFetchQueue([
      () => makeResponse({ choices: [{ message: { content: "hi from grok" } }] }),
    ]);
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Grok],
        credentials: { [ProviderId.Grok]: ["grok-key-1"] },
      }),
    );

    const response = await stack.provider.generate({
      message: "hello",
      tools: [],
    });

    expect(response).toEqual({ text: "hi from grok" });
    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(call?.init.headers.Authorization).toBe("Bearer grok-key-1");
    expect(JSON.parse(call?.init.body ?? "{}").model).toBe("grok-3");
  });

  it("uses the injectable adapter factory when provided", async () => {
    const factory = vi.fn().mockImplementation(
      (_provider: string, _s: ProviderSettings, _value: string | undefined) =>
        fakeProvider("from injected factory"),
    );
    const stack = composeProviderStack({
      ...makeOptions({
        chain: [ProviderId.Grok],
        credentials: { [ProviderId.Grok]: ["grok-key-1"] },
      }),
      adapterFactory: factory,
    });

    const response = await stack.provider.generate({
      message: "x",
      tools: [],
    });

    expect(response).toEqual({ text: "from injected factory" });
    expect(factory).toHaveBeenCalledWith(
      ProviderId.Grok,
      expect.objectContaining({ model: "grok-3" }),
      "grok-key-1",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Deterministic fallback ordering + rotation wiring
// ---------------------------------------------------------------------------

describe("deterministic fallback ordering", () => {
  it("rotates within a provider then moves to the next configured provider", async () => {
    const { captured } = stubFetchQueue([
      failWithUnavailable(),
      failWithUnavailable(),
      () =>
        makeResponse({
          candidates: [{ content: { parts: [{ text: "gemini wins" }] } }],
        }),
    ]);
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Grok, ProviderId.Gemini],
        credentials: {
          [ProviderId.Grok]: ["grok-key-1", "grok-key-2"],
          [ProviderId.Gemini]: ["gemini-key-1"],
        },
      }),
    );

    const response = await stack.provider.generate({ message: "x", tools: [] });

    expect(response).toEqual({ text: "gemini wins" });
    expect(captured).toHaveLength(3);
    // Credential rotation order: grok key #1 → grok key #2 → gemini key #1.
    // (Grok authenticates with Authorization/Bearer; Gemini uses x-goog-api-key.)
    const authOf = (c: CapturedRequest) =>
      c.init.headers.Authorization ?? c.init.headers["x-goog-api-key"];
    expect(captured.map(authOf)).toEqual([
      "Bearer grok-key-1",
      "Bearer grok-key-2",
      "gemini-key-1",
    ]);
    expect(captured[2]?.init.headers.Authorization).toBeUndefined();
    expect(captured[2]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    );
  });

  it("composes identical stacks from identical options", () => {
    const options = makeOptions({
      chain: [ProviderId.Grok, ProviderId.Ollama],
      credentials: { [ProviderId.Grok]: ["key-1", "key-2"] },
    });
    const first = composeProviderStack(options);
    const second = composeProviderStack(options);

    expect(second.chain).toEqual(first.chain);
    expect(second.credentialProviders).toEqual(first.credentialProviders);
    expect(second.credentials.all(ProviderId.Grok).map((h) => h.id)).toEqual(
      first.credentials.all(ProviderId.Grok).map((h) => h.id),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Credential secrecy
// ---------------------------------------------------------------------------

describe("credential secrecy", () => {
  it("keeps credential values out of the exhausted fallback error", async () => {
    const SECRET = "super-secret-grok-key";
    const { captured } = stubFetchQueue([failWithUnavailable()]);
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Grok],
        credentials: { [ProviderId.Grok]: [SECRET] },
      }),
    );

    // Exactly one provider with one credential: one attempt, then exhausted.
    try {
      await stack.provider.generate({ message: "x", tools: [] });
      expect.unreachable("must reject after exhausting providers");
    } catch (error) {
      expect(isProviderCompositionError(error)).toBe(false);
      expect(error).toBeInstanceOf(ProviderFallbackError);
      const err = error as ProviderFallbackError;
      expect(err.code).toBe(ProviderErrorCode.Unavailable);
      // Attempts expose provider + credential id — never the value.
      expect(err.attempted).toEqual([
        expect.objectContaining({
          provider: ProviderId.Grok,
          credentialId: "credential-1",
          code: ProviderErrorCode.Unavailable,
        }),
      ]);
      expect(JSON.stringify(err.attempted)).not.toContain(SECRET);
      expect(err.message).not.toContain(SECRET);
    }
    // The single attempt carried the intended Authorization header only.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.init.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it("exposes an opaque AgentProvider facade with nothing secret serializable", async () => {
    const SECRET = "super-secret-grok-key";
    stubFetchQueue([() => makeResponse({ choices: [{ message: { content: "" } }] })]);
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Grok],
        credentials: { [ProviderId.Grok]: [SECRET] },
      }),
    );

    // The Agent sees only a plain provider: no config, no credentials, no ids.
    expect(Object.keys(stack.provider).sort()).toEqual(["generate"]);
    expect(JSON.stringify(stack.provider)).not.toContain(SECRET);
    expect(typeof stack.provider.generate).toBe("function");
  });

  it("rotates to the next configured provider after an authentication failure", async () => {
    // 401 → Authentication. The fallback policy treats auth failures as
    // rotation-eligible, so the run moves grok → gemini (server-side only; the
    // secret is never retried on a different provider by value).
    const SECRET = "super-secret-grok-key";
    const { captured } = stubFetchQueue([
      () => makeResponse({}, 401),
      () =>
        makeResponse({
          candidates: [{ content: { parts: [{ text: "gemini ok" }] } }],
        }),
    ]);
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Grok, ProviderId.Gemini],
        credentials: {
          [ProviderId.Grok]: [SECRET],
          [ProviderId.Gemini]: ["gemini-key-1"],
        },
      }),
    );

    const response = await stack.provider.generate({ message: "x", tools: [] });

    expect(response).toEqual({ text: "gemini ok" });
    expect(captured).toHaveLength(2);
    // Grok carried the secret as its Bearer token (server-side only)…
    expect(captured[0]?.init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    // …Gemini authenticates with its own key, no Authorization leak.
    expect(captured[1]?.init.headers["x-goog-api-key"]).toBe("gemini-key-1");
    expect(captured[1]?.init.headers.Authorization).toBeUndefined();
  });

  it("stops immediately for non-rotatable failures without leaking the key", async () => {
    // A valid response with a non-JSON body → InvalidResponse, which the
    // fallback policy does NOT rotate on: the run stops with the ORIGINAL
    // typed provider error after a single attempt.
    const SECRET = "super-secret-grok-key";
    const { captured } = stubFetchQueue([
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("not JSON");
        },
      }),
    ]);
    const stack = composeProviderStack(
      makeOptions({
        chain: [ProviderId.Grok],
        credentials: { [ProviderId.Grok]: [SECRET] },
      }),
    );

    try {
      await stack.provider.generate({ message: "x", tools: [] });
      expect.unreachable("must reject");
    } catch (error) {
      // Original provider error, not a fallback error and not a composition
      // error: no rotation ever happened.
      expect(isProviderCompositionError(error)).toBe(false);
      expect(isProviderError(error)).toBe(true);
      const err = error as ProviderError;
      expect(err.code).toBe(ProviderErrorCode.InvalidResponse);
      expect(err.retryable).toBe(false);
      expect(err.message).not.toContain(SECRET);
    }
    expect(captured).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Composition failure behavior
// ---------------------------------------------------------------------------

describe("composition failure behavior", () => {
  it("fails synchronously at composition time without any request", () => {
    const requests: string[] = [];
    const fetch = async (input: string) => {
      requests.push(String(input));
      return makeResponse({});
    };
    vi.stubGlobal("fetch", fetch);

    const failures: Array<Partial<ProviderCompositionOptions>> = [
      { chain: [] },
      { chain: ["grok", "anthropic"] },
      { chain: ["grok", "grok"] },
      { chain: [ProviderId.Grok], credentials: { [ProviderId.Grok]: [] } },
      {
        chain: [ProviderId.Grok],
        settings: {
          ...makeOptions().settings,
          [ProviderId.Grok]: settings({ timeoutMs: 0 }),
        },
      },
    ];
    for (const bad of failures) {
      expect(() => composeProviderStack(makeOptions(bad))).toThrowError(
        ProviderCompositionError,
      );
    }

    // No provider was ever contacted — validation is pure + synchronous.
    expect(requests).toEqual([]);
  });

  it("reports every failure mode as a typed composition error", () => {
    expectCompositionFailure(
      () => composeProviderStack(makeOptions({ chain: [] })),
      "provider-composition/empty-order",
    );
    expectCompositionFailure(
      () => composeProviderStack(makeOptions({ chain: ["nope"] })),
      "provider-composition/unknown-provider",
      "nope",
    );
    expectCompositionFailure(
      () =>
        composeProviderStack(
          makeOptions({
            chain: [ProviderId.Grok],
            credentials: { [ProviderId.Grok]: [] },
          }),
        ),
      "provider-composition/missing-credentials",
      ProviderId.Grok,
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Credential health / cooldown integration (Phase 10.18)
// ---------------------------------------------------------------------------

describe("provider composition — credential health / cooldown", () => {
  it("skips a cooled-down credential by default (no option needed)", async () => {
    const { captured } = stubFetchQueue([failWithUnavailable()]);
    const stack = composeProviderStack(
      makeOptions({ credentials: { [ProviderId.Grok]: ["grok-key-1"] } }),
    );

    // Call 1: the only Grok credential fails as unavailable → cooling down.
    await expect(
      stack.provider.generate({ message: "x", tools: [] }),
    ).rejects.toBeInstanceOf(ProviderFallbackError);
    expect(captured).toHaveLength(1);

    // Call 2: the credential is still in cooldown → SKIPPED (typed), and the
    // provider is NOT contacted again — the queue's single remaining step
    // would throw if a request were made.
    try {
      await stack.provider.generate({ message: "x", tools: [] });
      expect.unreachable("all credentials cooling down must exhaust");
    } catch (error) {
      const err = error as ProviderFallbackError;
      expect(err.attempted[0]).toMatchObject({
        provider: ProviderId.Grok,
        credentialId: "credential-1",
        code: "provider/credential-cooldown",
      });
      expect(err.message).not.toContain("grok-key-1");
      expect(JSON.stringify(err.attempted)).not.toContain("grok-key-1");
    }

    // Still exactly one provider contact — the cooldown skip made no request.
    expect(captured).toHaveLength(1);
  });

  it("recovers a cooled credential once the cooldown window expires", async () => {
    const clock = { value: 1_000_000 };
    const health = createProviderHealth({
      cooldownMs: 60_000,
      now: () => clock.value,
    });
    const { captured } = stubFetchQueue([
      failWithUnavailable(),
      () => makeResponse({ choices: [{ message: { content: "recovered" } }] }),
    ]);
    const stack = composeProviderStack(
      makeOptions({
        credentials: { [ProviderId.Grok]: ["grok-key-1"] },
        health,
      }),
    );

    // Call 1: the only Grok credential fails as unavailable → cooling down.
    await expect(
      stack.provider.generate({ message: "x", tools: [] }),
    ).rejects.toBeInstanceOf(ProviderFallbackError);
    expect(captured).toHaveLength(1);

    // Call 2 (still within the window): skipped, no provider contact.
    try {
      await stack.provider.generate({ message: "x", tools: [] });
      expect.unreachable("must stay in cooldown");
    } catch (error) {
      expect((error as ProviderFallbackError).attempted[0]?.code).toBe(
        "provider/credential-cooldown",
      );
    }
    expect(captured).toHaveLength(1);

    // After the FIXED window passes, the same credential recovers and a fresh
    // call succeeds through it.
    clock.value += 60_000;

    const response = await stack.provider.generate({ message: "x", tools: [] });
    expect(response).toEqual({ text: "recovered" });
    expect(captured).toHaveLength(2);
  });
});