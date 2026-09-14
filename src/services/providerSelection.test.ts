/**
 * AI provider selection layer tests (Phase 10.10).
 *
 * These tests use FAKE providers/factories only — no Grok adapter network
 * calls, no API keys. They prove the selection layer:
 *
 *   1. Registers named provider factories and reports what is registered.
 *   2. Resolves a provider name deterministically through its factory,
 *      passing the selection config through.
 *   3. Never invokes a provider during resolution (no generate, no tool
 *      execution, no network).
 *   4. Rejects duplicate registration with a typed error.
 *   5. Fails clearly for unknown / unregistered provider names.
 *
 * Concrete adapter construction no longer lives here (Phase 10.17): the
 * composition root (`providerComposition.ts`) is the single place adapters
 * are built and configured; this registry stays a pure provider-agnostic
 * primitive.
 */
import { describe, expect, it, vi } from "vitest";

import {
  isProviderId,
  isProviderRegistryError,
  KNOWN_PROVIDER_IDS,
  ProviderId,
  ProviderRegistry,
  ProviderRegistryError,
} from "./providerSelection.js";
import {
  isProviderError,
  ProviderError,
  ProviderErrorCode,
} from "./provider.js";
import type { AgentProvider, AgentResponse } from "./provider.js";
import type { ProviderFactory } from "./providerSelection.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeProvider(text = "fake reply"): AgentProvider {
  return {
    generate: vi.fn<AgentProvider["generate"]>().mockResolvedValue({
      text,
    } satisfies AgentResponse),
  };
}

/** Register a fake factory under grok that records its config / calls. */
function installFakeGrok(
  registry: ProviderRegistry,
): ReturnType<typeof vi.fn<ProviderFactory<{ model: string }>>> {
  const factory = vi
    .fn<ProviderFactory<{ model: string }>>()
    .mockImplementation(() => fakeProvider("from grok factory"));
  registry.register(ProviderId.Grok, factory);
  return factory;
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

describe("ProviderRegistry — registration", () => {
  it("registers a named factory and reports it via has()", () => {
    const registry = new ProviderRegistry();
    const factory: ProviderFactory = () => fakeProvider();
    registry.register(ProviderId.Grok, factory);
    expect(registry.has(ProviderId.Grok)).toBe(true);
    expect(registry.registeredProviderIds).toEqual(["grok"]);
  });

  it("lists every registered provider id in registration order", () => {
    const registry = new ProviderRegistry();
    registry.register(ProviderId.Grok, () => fakeProvider());
    expect(registry.registeredProviderIds).toEqual(["grok"]);
    // A second provider id stays independent of the first.
    registry.register("gemini" as ProviderId, () => fakeProvider());
    expect(registry.registeredProviderIds).toEqual(["grok", "gemini"]);
  });

  it("rejects duplicate registration with a typed error", () => {
    const registry = new ProviderRegistry();
    registry.register(ProviderId.Grok, () => fakeProvider("first"));

    try {
      registry.register(ProviderId.Grok, () => fakeProvider("second"));
      expect.unreachable("duplicate registration must throw");
    } catch (error) {
      expect(isProviderRegistryError(error)).toBe(true);
      const err = error as ProviderRegistryError;
      expect(err.code).toBe("provider-selection/duplicate-registration");
      expect(err.providerId).toBe("grok");
      expect(err.message).toContain("already registered");
    }
  });

  it("keeps the first factory after a rejected duplicate registration", async () => {
    const registry = new ProviderRegistry();
    installFakeGrok(registry);
    expect(() =>
      registry.register(ProviderId.Grok, () => fakeProvider("intruder")),
    ).toThrowError(ProviderRegistryError);

    const resolved = registry.resolve({ provider: ProviderId.Grok });
    expect(await resolved.generate({ message: "x", tools: [] })).toMatchObject({
      text: "from grok factory",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Resolution
// ---------------------------------------------------------------------------

describe("ProviderRegistry — resolution", () => {
  it("resolves a provider through its registered factory", () => {
    const registry = new ProviderRegistry();
    const factory = installFakeGrok(registry);

    const provider = registry.resolve({
      provider: ProviderId.Grok,
      config: { model: "grok-3" },
    });

    expect(factory).toHaveBeenCalledWith({ model: "grok-3" });
    expect(typeof provider.generate).toBe("function");
  });

  it("passes the selection config through to the factory verbatim", () => {
    const registry = new ProviderRegistry();
    const factory = installFakeGrok(registry);
    const config = { model: "grok-3" };

    registry.resolve({ provider: ProviderId.Grok, config });

    // Deterministic: the exact configured selection reaches the factory.
    expect(factory).toHaveBeenCalledWith(config);
  });

  it("resolves the same name deterministically through the same factory", () => {
    const registry = new ProviderRegistry();
    const grokFactory = installFakeGrok(registry);
    const otherFactory = vi
      .fn<ProviderFactory>()
      .mockImplementation(() => fakeProvider("from other factory"));
    registry.register("openrouter" as ProviderId, otherFactory);

    const selection = { provider: ProviderId.Grok, config: { model: "x" } };
    registry.resolve(selection);
    registry.resolve(selection);

    expect(grokFactory).toHaveBeenCalledTimes(2);
    expect(grokFactory).toHaveBeenNthCalledWith(1, { model: "x" });
    expect(grokFactory).toHaveBeenNthCalledWith(2, { model: "x" });
    // Other providers are never touched by a grok resolution.
    expect(otherFactory).not.toHaveBeenCalled();
  });

  it("supports multiple registered providers independently", () => {
    const registry = new ProviderRegistry();
    installFakeGrok(registry);
    registry.register("ollama" as ProviderId, () => fakeProvider("ollama reply"));

    const grok = registry.resolve({ provider: ProviderId.Grok });
    const ollama = registry.resolve({ provider: "ollama" as ProviderId });

    expect(typeof grok.generate).toBe("function");
    expect(typeof ollama.generate).toBe("function");
    expect(ollama).not.toBe(grok);
  });

  it("never invokes the provider during resolution (no generate / no tools)", () => {
    const registry = new ProviderRegistry();
    const provider = fakeProvider();
    registry.register(ProviderId.Grok, () => provider);

    const resolved = registry.resolve({ provider: ProviderId.Grok });

    expect(resolved).toBe(provider);
    expect(provider.generate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown / missing providers
// ---------------------------------------------------------------------------

describe("ProviderRegistry — unknown providers fail clearly", () => {
  it("throws a typed error when nothing is registered under the id", () => {
    const registry = new ProviderRegistry();

    try {
      registry.resolve({ provider: ProviderId.Grok });
      expect.unreachable("unknown provider must throw");
    } catch (error) {
      expect(isProviderRegistryError(error)).toBe(true);
      const err = error as ProviderRegistryError;
      expect(err.code).toBe("provider-selection/unknown-provider");
      expect(err.providerId).toBe("grok");
      expect(err.message).toContain('No provider "grok" is registered');
      expect(err.message).toContain("none");
    }
  });

  it("lists the registered providers in the unknown-provider message", () => {
    const registry = new ProviderRegistry();
    installFakeGrok(registry);

    try {
      registry.resolve({ provider: "gemini" as ProviderId });
      expect.unreachable("unregistered name must throw");
    } catch (error) {
      const err = error as ProviderRegistryError;
      expect(isProviderRegistryError(err)).toBe(true);
      expect(err.providerId).toBe("gemini");
      expect(err.message).toContain('No provider "gemini" is registered');
      expect(err.message).toContain("grok");
    }
  });

  it("does not confuse unknown providers with provider failures", () => {
    expect(isProviderError(ProviderRegistryError.unknown("nope", []))).toBe(
      false,
    );
    expect(
      isProviderRegistryError(
        ProviderError.permanent(ProviderErrorCode.Unavailable, "down"),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Typed identifiers / known set
// ---------------------------------------------------------------------------

describe("ProviderId — typed identifiers", () => {
  it("exposes the known provider ids", () => {
    expect(KNOWN_PROVIDER_IDS).toContain("grok");
    expect(isProviderId("grok")).toBe(true);
    expect(KNOWN_PROVIDER_IDS).toContain("gemini");
    expect(isProviderId("gemini")).toBe(true);
    expect(KNOWN_PROVIDER_IDS).toContain("openrouter");
    expect(isProviderId("openrouter")).toBe(true);
    expect(KNOWN_PROVIDER_IDS).toContain("ollama");
    expect(isProviderId("ollama")).toBe(true);
    expect(isProviderId("anthropic")).toBe(false);
    expect(isProviderId("")).toBe(false);
  });
});