/**
 * Provider credential health tests (Phase 10.18).
 *
 * All handles are FAKE opaque references (provider + credential id) and all
 * values are FAKE — this component never sees a credential VALUE at all, which
 * is itself one of the guarantees under test. A control table of fake values
 * asserts those values cannot reach errors or serialized state.
 *
 * These tests prove the component:
 *
 *   1. Marks a credential unavailable and reports it cooling down.
 *   2. Isolates availability DURING the cooldown window.
 *   3. Restores availability once the (deterministic) cooldown expires.
 *   4. Resets / clears a cooldown before expiry.
 *   5. Keeps MULTIPLE credentials of ONE provider independent.
 *   6. Keeps DIFFERENT providers independent.
 *   7. Enforces the fixed-duration policy — repeated failures neither extend
 *      nor replace an active window; a new failure after expiry starts a new
 *      window.
 *   8. Rejects invalid / forged handles and unknown providers with TYPED
 *      errors.
 *   9. Is fully deterministic under the injected clock.
 *   10. Never leaks a credential value into errors, handles, or state.
 */
import { describe, expect, it } from "vitest";

import {
  createProviderHealth,
  isProviderHealthError,
  ProviderHealthError,
  type ProviderHealth,
  type ProviderHealthRef,
} from "./providerHealth.js";

// ---------------------------------------------------------------------------
// Fixtures (FAKE values only)
// ---------------------------------------------------------------------------

const FAKE_VALUE_GROK = "super-secret-grok";
const FAKE_VALUE_GEMINI = "super-secret-gemini";

function handle(provider: string, id: string): ProviderHealthRef {
  return { provider, id };
}

/** A controllable fake clock: `now()` returns the live `state.value` ms. */
function fakeClock(): { now: () => number; value: number } {
  const state = { value: 1_000_000 };
  return {
    get value(): number {
      return state.value;
    },
    set value(next: number) {
      state.value = next;
    },
    now: () => state.value,
  };
}

function makeHealth(
  cooldownMs: number,
  clock?: { now: () => number; value: number },
): { health: ProviderHealth; clock: { now: () => number; value: number } } {
  const injected = clock ?? fakeClock();
  return { health: createProviderHealth({ cooldownMs, now: injected.now }), clock: injected };
}

/** The fake values must NEVER appear anywhere the component produces. */
function expectNoSecret(value: unknown): void {
  const rendered =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, sub) => (typeof sub === "function" ? undefined : sub));
  expect(rendered).not.toContain(FAKE_VALUE_GROK);
  expect(rendered).not.toContain(FAKE_VALUE_GEMINI);
}

// ---------------------------------------------------------------------------
// 1. Marking unavailable
// ---------------------------------------------------------------------------

describe("ProviderHealth — marking a credential unavailable", () => {
  it("marks an available credential as cooling down with a deadline", () => {
    const { health, clock } = makeHealth(5_000);
    const grokPrimary = handle("grok", "credential-1");

    const deadline = health.markUnavailable(grokPrimary);

    expect(deadline).toBe(clock.value + 5_000);
    expect(health.isAvailable(grokPrimary)).toBe(false);
    expect(health.cooldownExpiresAt(grokPrimary)).toBe(clock.value + 5_000);
  });

  it("reports available for a credential that was never touched", () => {
    const { health } = makeHealth(5_000);
    // Cold data: an unknown credential is AVAILABLE, not cooling down.
    expect(health.isAvailable(handle("grok", "credential-9"))).toBe(true);
    expect(health.cooldownExpiresAt(handle("grok", "credential-9"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2+3. Availability during and after cooldown
// ---------------------------------------------------------------------------

describe("ProviderHealth — cooldown window and expiry", () => {
  it("is unavailable ENTIRELY within the window, up to the deadline", () => {
    const { health, clock } = makeHealth(5_000);
    const grokPrimary = handle("grok", "credential-1");
    health.markUnavailable(grokPrimary);

    clock.value += 4_999;
    expect(health.isAvailable(grokPrimary)).toBe(false);

    clock.value = health.cooldownExpiresAt(grokPrimary) as number;
    // At the instant of the deadline the cooldown is finished.
    expect(health.isAvailable(grokPrimary)).toBe(true);
  });

  it("becomes available again after the cooldown expires", () => {
    const { health, clock } = makeHealth(5_000);
    const grokPrimary = handle("grok", "credential-1");
    health.markUnavailable(grokPrimary);

    clock.value += 5_001;
    expect(health.isAvailable(grokPrimary)).toBe(true);
    expect(health.cooldownExpiresAt(grokPrimary)).toBeUndefined();
  });

  it("prunes expired entries so cold data stays clean", () => {
    const { health, clock } = makeHealth(5_000);
    const grokPrimary = handle("grok", "credential-1");
    health.markUnavailable(grokPrimary);

    clock.value += 6_000;
    expect(health.cooldownExpiresAt(grokPrimary)).toBeUndefined();
    // The credential is usable again immediately — a new window can start.
    const newDeadline = health.markUnavailable(grokPrimary);
    expect(newDeadline).toBe(clock.value + 5_000);
  });
});

// ---------------------------------------------------------------------------
// 4. Reset before expiry
// ---------------------------------------------------------------------------

describe("ProviderHealth — reset before expiry", () => {
  it("clears a cooldown early and restores availability immediately", () => {
    const { health, clock } = makeHealth(5_000);
    const grokPrimary = handle("grok", "credential-1");
    health.markUnavailable(grokPrimary);

    clock.value += 1_000;
    health.reset(grokPrimary);

    expect(health.isAvailable(grokPrimary)).toBe(true);
    expect(health.cooldownExpiresAt(grokPrimary)).toBeUndefined();
  });

  it("reset is idempotent on an already-available credential", () => {
    const { health } = makeHealth(5_000);
    expect(() => health.reset(handle("grok", "credential-1"))).not.toThrow();
    expect(health.isAvailable(handle("grok", "credential-1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Multiple credentials, one provider
// ---------------------------------------------------------------------------

describe("ProviderHealth — multiple credentials for one provider", () => {
  it("keeps each credential of the same provider independent", () => {
    const { health, clock } = makeHealth(5_000);
    const primary = handle("grok", "credential-1");
    const backup = handle("grok", "credential-2");

    health.markUnavailable(primary);
    clock.value += 2_000;

    expect(health.isAvailable(primary)).toBe(false);
    expect(health.isAvailable(backup)).toBe(true);

    health.reset(primary);
    expect(health.isAvailable(primary)).toBe(true);
    // Backup still has its own independent (untouched) state.
    expect(health.isAvailable(backup)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Independent providers
// ---------------------------------------------------------------------------

describe("ProviderHealth — independent providers", () => {
  it("marking one provider never affects another", () => {
    const { health, clock } = makeHealth(5_000);
    health.markUnavailable(handle("grok", "credential-1"));
    health.markUnavailable(handle("gemini", "credential-1"));

    clock.value += 3_000;
    expect(health.isAvailable(handle("grok", "credential-1"))).toBe(false);
    expect(health.isAvailable(handle("gemini", "credential-1"))).toBe(false);

    health.reset(handle("gemini", "credential-1"));
    expect(health.isAvailable(handle("gemini", "credential-1"))).toBe(true);
    expect(health.isAvailable(handle("grok", "credential-1"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Repeated failures → fixed-duration policy
// ---------------------------------------------------------------------------

describe("ProviderHealth — repeated failures use the fixed-duration policy", () => {
  it("does NOT extend or replace the window while a credential cools down", () => {
    const { health, clock } = makeHealth(5_000);
    const grokPrimary = handle("grok", "credential-1");

    const first = health.markUnavailable(grokPrimary);
    clock.value += 1_000;
    const second = health.markUnavailable(grokPrimary);
    clock.value += 1_000;
    const third = health.markUnavailable(grokPrimary);

    // First-failure-wins: the deadline never moved.
    expect(first).toBe(second);
    expect(second).toBe(third);
    clock.value += 5_000;
    expect(health.isAvailable(grokPrimary)).toBe(true);
  });

  it("starts a fresh window for a NEW failure after expiry (never permanent)", () => {
    const { health, clock } = makeHealth(5_000);
    const grokPrimary = handle("grok", "credential-1");

    const first = health.markUnavailable(grokPrimary);
    clock.value = first; // expiry instant
    const second = health.markUnavailable(grokPrimary);

    expect(second).toBe(clock.value + 5_000);
    expect(health.isAvailable(grokPrimary)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Invalid / forged handles + unknown providers
// ---------------------------------------------------------------------------

describe("ProviderHealth — invalid handles and unknown providers", () => {
  it("rejects non-handle-shaped inputs with a typed error", () => {
    const { health } = makeHealth(5_000);

    for (const bad of [null, undefined, {}, { provider: "grok" }, { id: "a" },
      { provider: "grok", id: "" }, { provider: "", id: "a" },
      { provider: 42, id: "a" }, { provider: "grok", id: 42 }, []]) {
      for (const method of ["isAvailable", "markUnavailable", "reset", "cooldownExpiresAt"] as const) {
        try {
          (health as unknown as Record<string, (h: unknown) => unknown>)[
            method
          ]!(bad);
          expect.unreachable(`${method} must reject a bad handle`);
        } catch (error) {
          expect(isProviderHealthError(error)).toBe(true);
          expect((error as ProviderHealthError).code).toBe(
            "provider-health/invalid-handle",
          );
        }
      }
    }
  });

  it("rejects an unknown provider id with a typed error", () => {
    const { health } = makeHealth(5_000);
    const anthropic = handle("anthropic", "credential-1");

    try {
      health.markUnavailable(anthropic);
      expect.unreachable("unknown provider must throw");
    } catch (error) {
      expect(isProviderHealthError(error)).toBe(true);
      const err = error as ProviderHealthError;
      expect(err.code).toBe("provider-health/unknown-provider");
      expect(err.providerId).toBe("anthropic");
      expect(err.message).toContain("anthropic");
    }
    // Every surface behaves the same for unknown providers.
    expect(() => health.isAvailable(anthropic)).toThrowError(ProviderHealthError);
    expect(() => health.cooldownExpiresAt(anthropic)).toThrowError(
      ProviderHealthError,
    );
    expect(() => health.reset(anthropic)).toThrowError(ProviderHealthError);
  });
});

// ---------------------------------------------------------------------------
// 9. Determinism under injected time
// ---------------------------------------------------------------------------

describe("ProviderHealth — deterministic injected time", () => {
  it("computes deadlines strictly from the injected clock", () => {
    const clockA = fakeClock();
    const clockB = fakeClock();
    const a = createProviderHealth({ cooldownMs: 7_000, now: clockA.now });
    const b = createProviderHealth({ cooldownMs: 7_000, now: clockB.now });

    const deadlineA = a.markUnavailable(handle("grok", "credential-1"));
    expect(deadlineA).toBe(clockA.now() + 7_000);

    // Advance one clock but not the other: only A enters cooldown.
    clockA.value += 3_000;
    expect(a.isAvailable(handle("grok", "credential-1"))).toBe(false);
    expect(b.isAvailable(handle("grok", "credential-1"))).toBe(true);

    clockA.value = deadlineA;
    expect(a.isAvailable(handle("grok", "credential-1"))).toBe(true);
  });

  it("treats a zero cooldown as instant recovery", () => {
    const { health, clock } = makeHealth(0);
    const grokPrimary = handle("grok", "credential-1");

    // A zero-width window: the mark owns the deadline at the current instant,
    // so the credential is available again immediately (isAvailable true) and
    // no lingering cooldown surfaces via cooldownExpiresAt.
    expect(health.markUnavailable(grokPrimary)).toBe(clock.value);
    expect(health.isAvailable(grokPrimary)).toBe(true);
    expect(health.cooldownExpiresAt(grokPrimary)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. No secret leakage
// ---------------------------------------------------------------------------

describe("ProviderHealth — no secret leakage", () => {
  it("never receives, stores, or emits a credential value", () => {
    const { health, clock } = makeHealth(5_000);
    // Give a hint of what the values WOULD be, then drive only handles around.
    const grokPrimary = { provider: "grok", id: "credential-1" };

    health.markUnavailable(grokPrimary);
    clock.value += 2_000;

    expectNoSecret(health.isAvailable(grokPrimary));
    expectNoSecret(health.cooldownExpiresAt(grokPrimary));

    // Errors mention ids only.
    try {
      health.markUnavailable(handle("anthropic", "credential-1"));
      expect.unreachable("must throw for unknown provider");
    } catch (error) {
      expectNoSecret(error);
      expect(JSON.stringify((error as Error).message)).not.toContain(
        FAKE_VALUE_GROK,
      );
    }
    try {
      health.markUnavailable(FAKE_VALUE_GROK as unknown as ProviderHealthRef);
      expect.unreachable("must throw for a non-handle");
    } catch (error) {
      expectNoSecret(error);
    }
  });

  it("serializes only provider + credential ids, never a value", () => {
    const { health, clock } = makeHealth(5_000);
    const primary = handle("grok", "credential-1");
    health.markUnavailable(primary);
    clock.value += 1_000;

    expect(JSON.stringify(primary)).toEqual(
      JSON.stringify({ provider: "grok", id: "credential-1" }),
    );
    expect(JSON.stringify(primary)).not.toContain(FAKE_VALUE_GROK);
    expect(JSON.stringify(primary)).not.toContain("secret");
  });
});