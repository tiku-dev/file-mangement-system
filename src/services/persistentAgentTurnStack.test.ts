/**
 * Persistent-agent-turn + composed-provider-stack integration tests
 * (Phase 10.20).
 *
 * The composed provider stack (fallback / credential rotation / health) runs
 * BEHIND the persistent turn service. These tests prove that:
 *
 *   1. The stack's `provider` facade is the single turn runner — no fallback /
 *      rotation / cooldown detail leaks into the turn API surface.
 *   2. Credential rotation, provider fallback, cooldown-skip, and total
 *      exhaustion all execute correctly across tool-call continuation rounds
 *      without leaking provider-specific secrets or state.
 *   3. Conversation persistence is atomic: all-or-nothing, even when the
 *      composed stack exhausts providers mid-turn.
 *   4. Auth remains authoritative: no stack-level success can bypass the
 *      session identity requirement.
 *   5. The `createPersistentTurnRuntime` factory binds a stack to the turn
 *      service once, proving the production integration point.
 *
 * HTTP is stubbed ONLY for the one real-adapter end-to-end test; all other
 * tests use scripted adapters injected via `adapterFactory` — no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerReadTools, readToolDefinitions } from "../tools/definitions/readTools.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import type { AgentToolCall } from "./agent.js";
import { ProviderError, ProviderErrorCode, type AgentProvider, type AgentProviderRequest } from "./provider.js";
import { ProviderFallbackError } from "./providerFallback.js";
import { ProviderId } from "./providerSelection.js";
import {
  composeProviderStack,
  type ComposedProviderStack,
  type ProviderCompositionOptions,
  type ProviderSettings,
} from "./providerComposition.js";
import {
  createConversationState,
  finalizeConversation,
} from "./conversation.js";
import { AgentConversationNotFoundError } from "../database/repositories/agentConversations.js";
import {
  runPersistentTurn,
  createPersistentTurnRuntime,
  type PersistentTurnInput,
  type PersistentTurnOptions,
} from "./persistentAgentTurn.js";

// ---------------------------------------------------------------------------
// Mocked repository (mirrors persistentAgentTurn.test.ts exactly).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  loadAgentConversationState: vi.fn(),
  persistAgentTurn: vi.fn(),
  beginAgentTurn: vi.fn(),
  appendAgentTurnRoundMessage: vi.fn(),
  completeAgentTurn: vi.fn(),
  cancelAgentTurn: vi.fn(),
}));

vi.mock("../database/repositories/agentConversations.js", () => ({
  loadAgentConversationState: mocks.loadAgentConversationState,
  persistAgentTurn: mocks.persistAgentTurn,
  beginAgentTurn: mocks.beginAgentTurn,
  appendAgentTurnRoundMessage: mocks.appendAgentTurnRoundMessage,
  completeAgentTurn: mocks.completeAgentTurn,
  cancelAgentTurn: mocks.cancelAgentTurn,
  AgentConversationNotFoundError: class AgentConversationNotFoundError extends Error {
    readonly code = "agent-conversation/not-found-or-not-owned";
    constructor() {
      super("Agent conversation not found for this user.");
      this.name = "AgentConversationNotFoundError";
    }
  },
}));

/**
 * Reset every repository mock; tool rounds are defaulted to REAL persisted
 * ids so the eager begin/append/complete wiring works unless overridden.
 */
function resetPersistenceMocks(): void {
  mocks.loadAgentConversationState.mockReset();
  mocks.persistAgentTurn.mockReset().mockResolvedValue({ id: "conv-stack", created: true });
  mocks.beginAgentTurn.mockReset().mockResolvedValue({
    conversationId: "conv-stack",
    created: true,
    instructionMessageId: "inst-1",
    messageId: "msg-r1",
  });
  mocks.appendAgentTurnRoundMessage.mockReset().mockResolvedValue({ messageId: "msg-r2" });
  mocks.completeAgentTurn.mockReset().mockResolvedValue(undefined);
  mocks.cancelAgentTurn.mockReset().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};
const USER_ID = ACTIVE_USER.id;

function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

function makeFilesystem(): FilesystemExecutor {
  return {
    async listDirectory(path: string): Promise<DirectoryListing> {
      return { path, parentPath: null, isHome: false, items: [] };
    },
    async searchFiles() {
      return [];
    },
    async getFileMetadata() {
      throw new Error("not used in this test");
    },
    async readFile() {
      throw new Error("not used in this test");
    },
    async moveFile() {
      throw new Error("not used in this test");
    },
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  return registry;
}

function homeListing(path = "/home"): DirectoryListing {
  return { path, parentPath: null, isHome: false, items: [] };
}

const INSTRUCTION = "List my files.";
const TOOLS = readToolDefinitions;
const FILESYSTEM = makeFilesystem();
const REGISTRY = makeRegistry();

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

// ---------------------------------------------------------------------------
// Composed-stack fixtures: scripted adapters via adapterFactory
// ---------------------------------------------------------------------------

function providerSettings(id: string): ProviderSettings {
  const table: Record<string, ProviderSettings> = {
    [ProviderId.Grok]: { model: "grok-3", baseUrl: "https://api.x.ai/v1", timeoutMs: 60_000 },
    [ProviderId.Gemini]: {
      model: "gemini-3.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      timeoutMs: 60_000,
    },
    [ProviderId.OpenRouter]: {
      model: "anthropic/claude-sonnet-4",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 60_000,
    },
    [ProviderId.Ollama]: {
      model: "qwen3",
      baseUrl: "http://localhost:11434/api",
      timeoutMs: 120_000,
    },
  };
  const found = table[id];
  if (found === undefined) throw new Error(`no fixture settings for ${id}`);
  return found;
}

type ScriptedAdapter = AgentProvider;

interface ScriptStackOpts {
  chain: string[];
  credentials?: Partial<Record<string, string[]>>;
  script: (provider: string, credentialValue: string | undefined) => ScriptedAdapter;
}

function composeScriptedStack(opts: ScriptStackOpts): {
  stack: ComposedProviderStack;
  builds: Array<{ provider: string; credentialValue: string | undefined }>;
} {
  const builds: Array<{ provider: string; credentialValue: string | undefined }> = [];
  const DEFAULT_CREDENTIALS: Record<string, string[]> = {
    [ProviderId.Grok]: ["grok-key-1"],
    [ProviderId.Gemini]: ["gemini-key-1"],
    [ProviderId.OpenRouter]: ["openrouter-key-1"],
  };
  const credentialMap: Record<string, string[]> = {
    ...DEFAULT_CREDENTIALS,
    ...opts.credentials,
  } as Record<string, string[]>;
  const settingsTable: Record<string, ProviderSettings> = {};
  for (const id of opts.chain) settingsTable[id] = providerSettings(id);

  const stack = composeProviderStack({
    chain: opts.chain,
    settings: settingsTable,
    credentials: credentialMap,
    adapterFactory: (provider, _settings, credentialValue) => {
      builds.push({ provider, credentialValue });
      return opts.script(provider, credentialValue);
    },
  });

  return { stack, builds };
}

function neverGenerateScript(): ScriptedAdapter {
  return { generate: vi.fn<AgentProvider["generate"]>() };
}

function unavailable(): ProviderError {
  return ProviderError.transient(ProviderErrorCode.Unavailable, "provider down");
}

// ---------------------------------------------------------------------------
// 0. Provider-source validation
// ---------------------------------------------------------------------------

describe("runPersistentTurn — provider source validation (Phase 10.20)", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("throws TypeError when neither stack nor provider is supplied", async () => {
    await expect(
      runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
        tools: TOOLS,
        registry: REGISTRY,
        filesystem: FILESYSTEM,
      } as unknown as PersistentTurnOptions),
    ).rejects.toThrow(TypeError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("throws TypeError when both stack and provider are supplied", async () => {
    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => neverGenerateScript(),
    });

    await expect(
      runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
        tools: TOOLS,
        registry: REGISTRY,
        filesystem: FILESYSTEM,
        provider: neverGenerateScript(),
        stack,
      }),
    ).rejects.toThrow(TypeError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1. Primary provider success
// ---------------------------------------------------------------------------

describe("runPersistentTurn — primary provider success via stack", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("creates a conversation via the stack's single provider and persists", async () => {
    const { stack, builds } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => ({
        generate: vi.fn<AgentProvider["generate"]>().mockResolvedValue({ text: "Grok reply." }),
      }),
    });
    mocks.persistAgentTurn.mockResolvedValue({ id: "conv-1", created: true });

    const result = await runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
      stack,
      maxToolRounds: 1,
    });

    expect(result.conversationId).toBe("conv-1");
    expect(result.created).toBe(true);
    expect(result.state.instruction).toBe(INSTRUCTION);
    expect(result.state.finalText).toBe("Grok reply.");

    // The stack's facade ran; the single Grok credential was built once.
    expect(builds).toEqual([{ provider: ProviderId.Grok, credentialValue: "grok-key-1" }]);

    expect(mocks.persistAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.persistAgentTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      instruction: INSTRUCTION,
      maxToolRounds: 1,
      rounds: [],
      finalText: "Grok reply.",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Credential rotation followed by success
// ---------------------------------------------------------------------------

describe("runPersistentTurn — credential rotation inside the stack", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("rotates a failing credential to the next and persists the winning turn", async () => {
    const { stack, builds } = composeScriptedStack({
      chain: [ProviderId.Grok],
      credentials: { [ProviderId.Grok]: ["grok-k1", "grok-k2"] },
      script: (provider, credentialValue) => {
        if (credentialValue === "grok-k1") {
          return { generate: vi.fn<AgentProvider["generate"]>().mockRejectedValue(unavailable()) };
        }
        return { generate: vi.fn<AgentProvider["generate"]>().mockResolvedValue({ text: "Rotated ok." }) };
      },
    });
    mocks.persistAgentTurn.mockResolvedValue({ id: "conv-rot", created: true });

    const result = await runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
      stack,
      maxToolRounds: 1,
    });

    expect(result.state.finalText).toBe("Rotated ok.");
    expect(builds.map((b) => b.credentialValue)).toEqual(["grok-k1", "grok-k2"]);

    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, finalText: "Rotated ok." }),
    );
    // No key value is ever persisted.
    const persisted = mocks.persistAgentTurn.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain("grok-k1");
    expect(JSON.stringify(persisted)).not.toContain("grok-k2");
  });
});

// ---------------------------------------------------------------------------
// 3. Provider fallback followed by success
// ---------------------------------------------------------------------------

describe("runPersistentTurn — provider fallback inside the stack", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("falls back to gemini when grok fails and persists the fallback turn", async () => {
    const { stack, builds } = composeScriptedStack({
      chain: [ProviderId.Grok, ProviderId.Gemini],
      script: (provider) =>
        provider === ProviderId.Grok
          ? { generate: vi.fn<AgentProvider["generate"]>().mockRejectedValue(unavailable()) }
          : { generate: vi.fn<AgentProvider["generate"]>().mockResolvedValue({ text: "Fallback ok." }) },
    });
    mocks.persistAgentTurn.mockResolvedValue({ id: "conv-fb", created: true });

    const result = await runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
      stack,
      maxToolRounds: 1,
    });

    expect(result.state.finalText).toBe("Fallback ok.");
    expect(builds.map((b) => b.provider)).toEqual([ProviderId.Grok, ProviderId.Gemini]);

    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, finalText: "Fallback ok." }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Total exhaustion → no persistence
// ---------------------------------------------------------------------------

describe("runPersistentTurn — exhaustion persists nothing", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("rejects with a fallback ProviderError when every provider is unavailable", async () => {
    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok, ProviderId.Gemini],
      script: () => ({ generate: vi.fn<AgentProvider["generate"]>().mockRejectedValue(unavailable()) }),
    });

    await expect(
      runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
        tools: TOOLS,
        registry: REGISTRY,
        filesystem: FILESYSTEM,
        stack,
        maxToolRounds: 1,
      }),
    ).rejects.toThrow(ProviderFallbackError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("persists nothing when exhaustion happens during a resumed turn", async () => {
    let previous = createConversationState({ instruction: "First turn", maxToolRounds: 2 });
    previous = finalizeConversation(previous, "First reply.");
    mocks.loadAgentConversationState.mockResolvedValue(previous);

    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => ({ generate: vi.fn<AgentProvider["generate"]>().mockRejectedValue(unavailable()) }),
    });

    await expect(
      runPersistentTurn(sessionContext(ACTIVE_USER), { conversationId: "conv-9", instruction: INSTRUCTION }, {
        tools: TOOLS,
        registry: REGISTRY,
        filesystem: FILESYSTEM,
        stack,
        maxToolRounds: 1,
      }),
    ).rejects.toThrow(ProviderFallbackError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("propagates a non-retryable error without reaching the next provider", async () => {
    const gemini = { generate: vi.fn<AgentProvider["generate"]>().mockResolvedValue({ text: "never called" }) };
    const { stack, builds } = composeScriptedStack({
      chain: [ProviderId.Grok, ProviderId.Gemini],
      script: (provider) =>
        provider === ProviderId.Grok
          ? {
              generate: vi.fn<AgentProvider["generate"]>().mockRejectedValue(
                ProviderError.permanent(ProviderErrorCode.InvalidResponse, "garbage"),
              ),
            }
          : gemini,
    });

    await expect(
      runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
        tools: TOOLS,
        registry: REGISTRY,
        filesystem: FILESYSTEM,
        stack,
        maxToolRounds: 1,
      }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });

    expect(gemini.generate).not.toHaveBeenCalled();
    expect(builds).toEqual([{ provider: ProviderId.Grok, credentialValue: "grok-key-1" }]);
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Tool continuation switching providers across rounds
// ---------------------------------------------------------------------------

describe("runPersistentTurn — provider switching preserves tool continuation", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("skips the cooled-down provider and continues tool rounds on the fallback", async () => {
    const counters = { grokCalls: 0, geminiCalls: 0 };
    const geminiRequests: AgentProviderRequest[] = [];

    const { stack, builds } = composeScriptedStack({
      chain: [ProviderId.Grok, ProviderId.Gemini],
      script: (provider) => {
        if (provider === ProviderId.Grok) {
          return {
            generate: vi.fn<AgentProvider["generate"]>().mockImplementation(async () => {
              counters.grokCalls += 1;
              throw unavailable();
            }),
          };
        }
        return {
          generate: vi.fn<AgentProvider["generate"]>().mockImplementation(async (request: AgentProviderRequest) => {
            geminiRequests.push(request);
            counters.geminiCalls += 1;
            if (counters.geminiCalls === 1) {
              return { toolCalls: [call("c1", "list_directory", { path: "/home" })] };
            }
            return { text: "Everything listed." };
          }),
        };
      },
    });
    mocks.loadAgentConversationState.mockResolvedValue(null);

    const result = await runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
      stack,
      maxToolRounds: 2,
    });

    expect(result.state.toolRounds).toBe(1);
    expect(result.state.toolResults).toEqual([{ ok: true, callId: "c1", data: homeListing() }]);
    expect(result.state.finalText).toBe("Everything listed.");

    // Round 1: grok tried and failed (cooling). Round 2: grok skipped (cooldown),
    // gemini continues with the round-1 tool result in context.
    expect(counters.grokCalls).toBe(1);
    expect(counters.geminiCalls).toBe(2);
    expect(geminiRequests[0]!.message).toBe(INSTRUCTION);
    expect(geminiRequests[1]!.toolResults).toEqual([{ ok: true, callId: "c1", data: homeListing() }]);

    expect(builds).toEqual([
      { provider: ProviderId.Grok, credentialValue: "grok-key-1" },
      { provider: ProviderId.Gemini, credentialValue: "gemini-key-1" },
      { provider: ProviderId.Gemini, credentialValue: "gemini-key-1" },
    ]);

    // Eagerly began on the first tool round, then completed against that
    // conversation with the round's persisted message id.
    expect(mocks.beginAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.completeAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        rounds: [
          {
            messageId: "msg-r1",
            toolResults: [{ ok: true, callId: "c1", data: homeListing() }],
          },
        ],
        finalText: "Everything listed.",
      }),
    );
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("runs the invokeTool pipeline through the stack and persists tool results", async () => {
    const counters = { round: 0 };
    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => ({
        generate: vi.fn<AgentProvider["generate"]>().mockImplementation(async () => {
          counters.round += 1;
          if (counters.round === 1) {
            return { toolCalls: [call("c1", "list_directory", { path: "/home" })] };
          }
          return { text: "Everything listed." };
        }),
      }),
    });
    mocks.beginAgentTurn.mockResolvedValue({
      conversationId: "conv-exec",
      created: true,
      instructionMessageId: "inst-exec",
      messageId: "msg-r1",
    });

    const result = await runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
      stack,
      maxToolRounds: 2,
    });

    expect(result.conversationId).toBe("conv-exec");
    expect(result.state.toolRounds).toBe(1);
    expect(result.state.toolResults).toEqual([{ ok: true, callId: "c1", data: homeListing() }]);
    expect(result.state.finalText).toBe("Everything listed.");

    // The tool round was EAGERLY begun (real persisted ids), then completed
    // against that conversation with the persisted message id.
    expect(mocks.beginAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.completeAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-exec",
        rounds: [
          {
            messageId: "msg-r1",
            toolResults: [{ ok: true, callId: "c1", data: homeListing() }],
          },
        ],
        finalText: "Everything listed.",
      }),
    );
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Auth stays authoritative
// ---------------------------------------------------------------------------

describe("runPersistentTurn — auth with composed stack", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("rejects an unauthenticated session before running the stack", async () => {
    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => neverGenerateScript(),
    });

    await expect(
      runPersistentTurn(sessionContext(undefined), { instruction: INSTRUCTION }, {
        tools: TOOLS,
        registry: REGISTRY,
        filesystem: FILESYSTEM,
        stack,
      }),
    ).rejects.toThrow(AppError);

    expect(mocks.loadAgentConversationState).not.toHaveBeenCalled();
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("rejects a foreign conversation before running the stack", async () => {
    mocks.loadAgentConversationState.mockResolvedValue(null);
    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => neverGenerateScript(),
    });

    await expect(
      runPersistentTurn(sessionContext(ACTIVE_USER), { conversationId: "conv-foreign", instruction: "sneak" }, {
        tools: TOOLS,
        registry: REGISTRY,
        filesystem: FILESYSTEM,
        stack,
      }),
    ).rejects.toThrow(AgentConversationNotFoundError);

    expect(mocks.loadAgentConversationState).toHaveBeenCalledWith(USER_ID, "conv-foreign");
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. Loop bound respected through the stack
// ---------------------------------------------------------------------------

describe("runPersistentTurn — loop bound via stack", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("rejects with the typed loop error and persists nothing", async () => {
    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => ({
        generate: vi.fn<AgentProvider["generate"]>().mockResolvedValue({
          toolCalls: [call("a", "list_directory", { path: "/x" })],
        }),
      }),
    });

    await expect(
      runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: "keep going" }, {
        tools: TOOLS,
        registry: REGISTRY,
        filesystem: FILESYSTEM,
        stack,
        maxToolRounds: 1,
      }),
    ).rejects.toMatchObject({
      name: "AgentLoopError",
      code: "agent/max-tool-rounds-reached",
    });

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
    // The executed round's eager rows are compensated away: no partial state.
    expect(mocks.cancelAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.cancelAgentTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      conversationId: "conv-stack",
      created: true,
      messageIds: ["inst-1", "msg-r1"],
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Secrets never appear in state or persistence
// ---------------------------------------------------------------------------

describe("runPersistentTurn — secret containment", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("never puts credential values or fallback details into state or persistence", async () => {
    const SENTINEL = "TOP_SECRET_abc123";

    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok],
      credentials: { [ProviderId.Grok]: [SENTINEL] },
      script: () => ({ generate: vi.fn<AgentProvider["generate"]>().mockResolvedValue({ text: "Secret safe." }) }),
    });
    mocks.persistAgentTurn.mockResolvedValue({ id: "conv-safe", created: true });

    const result = await runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
      stack,
      maxToolRounds: 1,
    });

    const stateJson = JSON.stringify(result.state);
    const persistedJson = JSON.stringify(mocks.persistAgentTurn.mock.calls[0]![0]);

    expect(stateJson).not.toContain(SENTINEL);
    expect(persistedJson).not.toContain(SENTINEL);
    expect(stateJson).not.toContain("credential-1");
    expect(stateJson).not.toContain("provider/unavailable");
  });
});

// ---------------------------------------------------------------------------
// 9. Runtime factory binds the stack once
// ---------------------------------------------------------------------------

describe("createPersistentTurnRuntime (Phase 10.20)", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("runs a durable turn through the bound composed stack", async () => {
    const { stack, builds } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => ({ generate: vi.fn<AgentProvider["generate"]>().mockResolvedValue({ text: "Runtime ok." }) }),
    });
    mocks.persistAgentTurn.mockResolvedValue({ id: "conv-rt", created: true });

    const runtime = createPersistentTurnRuntime({
      stack,
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
      maxToolRounds: 1,
    });

    const result = await runtime.run(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION });
    expect(result.conversationId).toBe("conv-rt");
    expect(result.state.finalText).toBe("Runtime ok.");
    expect(builds).toEqual([{ provider: ProviderId.Grok, credentialValue: "grok-key-1" }]);

    // The runtime run() mirrors runPersistentTurn's persistence contract.
    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, finalText: "Runtime ok." }),
    );
  });

  it("rejects an unauthenticated turn via the runtime", async () => {
    const { stack } = composeScriptedStack({
      chain: [ProviderId.Grok],
      script: () => neverGenerateScript(),
    });

    const runtime = createPersistentTurnRuntime({
      stack,
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
    });

    await expect(
      runtime.run(sessionContext(undefined), { instruction: INSTRUCTION }),
    ).rejects.toThrow(AppError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. Real-adapter end-to-end (fetch stubbed; actual Grok adapter)
// ---------------------------------------------------------------------------

describe("runPersistentTurn — through the real Grok adapter", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("persists a response obtained from a real adapter via the composed stack", async () => {
    const captured: Array<{ url: string; init: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      async (input: string, init: unknown) => {
        captured.push({ url: String(input), init: init as Record<string, unknown> });
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "Real adapter ok." } }] }),
        };
      },
    );

    const stack = composeProviderStack({
      chain: [ProviderId.Grok],
      settings: { [ProviderId.Grok]: providerSettings(ProviderId.Grok) },
      credentials: { [ProviderId.Grok]: ["real-grok-key"] },
    });
    mocks.persistAgentTurn.mockResolvedValue({ id: "conv-real", created: true });

    const result = await runPersistentTurn(sessionContext(ACTIVE_USER), { instruction: INSTRUCTION }, {
      tools: TOOLS,
      registry: REGISTRY,
      filesystem: FILESYSTEM,
      stack,
      maxToolRounds: 1,
    });

    expect(result.state.finalText).toBe("Real adapter ok.");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toContain("/chat/completions");
    expect(captured[0]!.init.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer real-grok-key" }),
    );

    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, finalText: "Real adapter ok." }),
    );
    const persisted = mocks.persistAgentTurn.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain("real-grok-key");
  });
});