/**
 * Persistent agent turn orchestration tests (Phase 10.8 + 10.28C-prep).
 *
 * The repository persistence functions are mocked; everything else is real:
 * the Phase 10.5 auth/context builder, the Phase 10.4 bounded loop with a
 * scripted FAKE provider (no real AI, no keys, no network), the Phase 10.6
 * state transitions, and the tool policy / `invokeTool()` pipeline.
 *
 * Phase 10.28C-prep coverage:
 *
 *   1. Create: a tool turn EAGERLY persists its conversation + instruction +
 *      first round assistant message via `beginAgentTurn` BEFORE the round's
 *      tools run; later rounds append their own message via
 *      `appendAgentTurnRoundMessage`; the results + final are attached in ONE
 *      `completeAgentTurn` transaction. Text-only turns keep the original
 *      atomic `persistAgentTurn` write.
 *   2. Resume: an owned conversation is loaded, its round bound is inherited,
 *      and the turn is completed against the SAME conversation id.
 *   3. Ordering: each round's assistant message is persisted BEFORE its tool
 *      execution, and the persisted `conversationId`/`messageId` reach the
 *      tool policy boundary (the invocation boundary).
 *   4. Failures: a turn that fails after eager persistence is COMPENSATED via
 *      `cancelAgentTurn` — a new conversation is removed (cascade), a resumed
 *      conversation loses exactly this turn's messages — so no invalid or
 *      partial turn state remains. Failures before the first eager commit
 *      persist nothing at all.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerReadTools, readToolDefinitions } from "../tools/definitions/readTools.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import { defaultToolPolicy, type ToolExecutionContext, type ToolPolicy } from "../tools/policy.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import type { AgentToolCall } from "./agent.js";
import type { AgentProvider, AgentProviderRequest, AgentResponse } from "./provider.js";
import { ProviderError, ProviderErrorCode } from "./provider.js";
import {
  AgentConversationNotFoundError,
} from "../database/repositories/agentConversations.js";
import {
  createConversationState,
  finalizeConversation,
} from "./conversation.js";
import { runPersistentTurn, type PersistentTurnOptions } from "./persistentAgentTurn.js";

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

// ---------------------------------------------------------------------------
// Fixtures
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

/**
 * A fake FilesystemExecutor (no Tauri/Rust). When `events` is supplied, every
 * executor call is recorded so tests can assert the order of tool execution
 * against repository persistence calls.
 */
function makeFilesystem(events?: string[]): FilesystemExecutor {
  return {
    async listDirectory(path: string): Promise<DirectoryListing> {
      events?.push("exec:listDirectory");
      return { path, parentPath: null, isHome: false, items: [] };
    },
    async searchFiles() {
      events?.push("exec:searchFiles");
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

type Generate = AgentProvider["generate"];

function scriptedProvider(
  responses: Array<AgentResponse | ProviderError>,
): { generate: Mock<Generate>; requests: AgentProviderRequest[] } {
  const requests: AgentProviderRequest[] = [];
  const generate = vi.fn<Generate>().mockImplementation(async (request) => {
    requests.push(request);
    const response = responses[requests.length - 1];
    if (response === undefined) {
      throw new Error("fake provider script exhausted");
    }
    if (response instanceof ProviderError) throw response;
    return response;
  });
  return { generate, requests };
}

function makeOptions(
  provider: AgentProvider,
  override?: {
    registry?: ToolRegistry;
    maxToolRounds?: number;
    policy?: ToolPolicy;
    filesystem?: FilesystemExecutor;
  },
): PersistentTurnOptions {
  return {
    provider,
    tools: readToolDefinitions,
    registry: override?.registry ?? makeRegistry(),
    filesystem: override?.filesystem ?? makeFilesystem(),
    ...(override?.policy !== undefined ? { policy: override.policy } : {}),
    maxToolRounds: override?.maxToolRounds,
  };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

function homeListing(path = "/home"): DirectoryListing {
  return { path, parentPath: null, isHome: false, items: [] };
}

function expectComplete(state: { finalText?: string; toolRounds: number }) {
  expect(state.finalText).toBeDefined();
  expect(state.toolRounds).toBeGreaterThanOrEqual(0);
}

/**
 * Reset every repository mock and apply the defaults the persistent-turn
 * service depends on (real ids for eager rows, silent complete/cancel).
 */
function resetPersistenceMocks(): void {
  mocks.loadAgentConversationState.mockReset();
  mocks.persistAgentTurn.mockReset().mockResolvedValue({ id: "conv-1", created: true });
  mocks.beginAgentTurn.mockReset().mockResolvedValue({
    conversationId: "conv-1",
    created: true,
    instructionMessageId: "inst-1",
    messageId: "msg-r1",
  });
  mocks.appendAgentTurnRoundMessage.mockReset().mockResolvedValue({ messageId: "msg-r2" });
  mocks.completeAgentTurn.mockReset().mockResolvedValue(undefined);
  mocks.cancelAgentTurn.mockReset().mockResolvedValue(undefined);
}
// ---------------------------------------------------------------------------
// 1. Create a new conversation
// ---------------------------------------------------------------------------

describe("runPersistentTurn — create", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("eagerly persists the conversation + first message before tools run, then completes", async () => {
    const { generate, requests } = scriptedProvider([
      { toolCalls: [call("c1", "list_directory", { path: "/home" })] },
      { text: "Everything listed." },
    ]);

    const result = await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "List my files.", title: "Listing turn" },
      makeOptions({ generate }, { maxToolRounds: 2 }),
    );

    expect(result.conversationId).toBe("conv-1");
    expect(result.created).toBe(true);
    expectComplete(result.state);
    expect(result.state.instruction).toBe("List my files.");
    expect(result.state.finalText).toBe("Everything listed.");
    expect(result.state.toolRounds).toBe(1);
    expect(result.state.toolResults).toEqual([{ ok: true, callId: "c1", data: homeListing() }]);

    // The provider saw only REGISTERED tool metadata.
    expect(requests[0]).toEqual({ message: "List my files.", tools: readToolDefinitions });

    // One EAGER commit for the first tool round: conversation + instruction +
    // first assistant message. No conversationId (a new conversation).
    expect(mocks.beginAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.beginAgentTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      instruction: "List my files.",
      maxToolRounds: 2,
      title: "Listing turn",
      toolCalls: [call("c1", "list_directory", { path: "/home" })],
    });

    // The final write attaches the round's results + final reply to the eager
    // message ids returned by begin.
    expect(mocks.completeAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.completeAgentTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      conversationId: "conv-1",
      rounds: [
        {
          messageId: "msg-r1",
          toolResults: [{ ok: true, callId: "c1", data: homeListing() }],
        },
      ],
      finalText: "Everything listed.",
    });
    // Tool turns do not use the atomic single-write path.
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("persists the first round's free-form text when the provider sends both", async () => {
    const { generate } = scriptedProvider([
      { text: "Working on it…", toolCalls: [call("s", "search_files", { query: "notes" })] },
      { text: "Found them." },
    ]);

    await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "Find notes." },
      makeOptions({ generate }, { maxToolRounds: 2 }),
    );

    expect(mocks.beginAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Working on it…",
        toolCalls: [call("s", "search_files", { query: "notes" })],
      }),
    );
  });

  it("rejects an unauthenticated session before contacting the provider or persisting", async () => {
    const { generate } = scriptedProvider([{ text: "never asked" }]);

    await expect(
      runPersistentTurn(
        sessionContext(undefined),
        { instruction: "hi" },
        makeOptions({ generate }),
      ),
    ).rejects.toThrow(AppError);

    expect(generate).not.toHaveBeenCalled();
    expect(mocks.loadAgentConversationState).not.toHaveBeenCalled();
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
    expect(mocks.beginAgentTurn).not.toHaveBeenCalled();
  });
});
// ---------------------------------------------------------------------------
// 2. Resume an existing conversation
// ---------------------------------------------------------------------------

describe("runPersistentTurn — resume", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("loads the owned conversation and inherits its round bound", async () => {
    let previous = createConversationState({ instruction: "First turn", maxToolRounds: 3 });
    previous = finalizeConversation(previous, "First reply.");
    mocks.loadAgentConversationState.mockResolvedValue(previous);
    mocks.persistAgentTurn.mockResolvedValue({ id: "conv-9", created: false });

    const { generate } = scriptedProvider([{ text: "Second reply." }]);

    const result = await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { conversationId: "conv-9", instruction: "Second turn." },
      makeOptions({ generate }),
    );

    expect(mocks.loadAgentConversationState).toHaveBeenCalledWith(USER_ID, "conv-9");
    expect(result.conversationId).toBe("conv-9");
    expect(result.created).toBe(false);
    expect(result.state.instruction).toBe("Second turn.");
    expect(result.state.finalText).toBe("Second reply.");

    // A text-only resume keeps the original atomic write, bound inherited.
    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: "conv-9",
        maxToolRounds: 3,
      }),
    );
    expect(mocks.beginAgentTurn).not.toHaveBeenCalled();
  });

  it("runs a tool turn against the loaded conversation id", async () => {
    let previous = createConversationState({ instruction: "First turn", maxToolRounds: 3 });
    previous = finalizeConversation(previous, "First reply.");
    mocks.loadAgentConversationState.mockResolvedValue(previous);
    mocks.beginAgentTurn.mockResolvedValue({
      conversationId: "conv-9",
      created: false,
      instructionMessageId: "inst-9",
      messageId: "msg-r1",
    });

    const { generate } = scriptedProvider([
      { toolCalls: [call("c1", "list_directory", { path: "/home" })] },
      { text: "Done." },
    ]);

    await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { conversationId: "conv-9", instruction: "Second turn." },
      makeOptions({ generate }, { maxToolRounds: 2 }),
    );

    expect(mocks.beginAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: "conv-9",
        maxToolRounds: 3,
      }),
    );
    expect(mocks.completeAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: "conv-9",
        finalText: "Done.",
      }),
    );
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("rejects a foreign or missing conversation before running anything", async () => {
    mocks.loadAgentConversationState.mockResolvedValue(null);
    const { generate } = scriptedProvider([{ text: "never asked" }]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { conversationId: "conv-foreign", instruction: "sneak" },
        makeOptions({ generate }),
      ),
    ).rejects.toThrow(AgentConversationNotFoundError);

    expect(generate).not.toHaveBeenCalled();
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
    expect(mocks.beginAgentTurn).not.toHaveBeenCalled();
  });
});
// ---------------------------------------------------------------------------
// 3 & 4. Successful tool loop and text-only final
// ---------------------------------------------------------------------------

describe("runPersistentTurn — loop outcomes", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("persists a multi-round tool transcript eagerly round-by-round", async () => {
    const { generate } = scriptedProvider([
      { toolCalls: [call("s", "search_files", { query: "notes" })] },
      { toolCalls: [call("t", "list_directory", { path: "/tmp" })] },
      { text: "Search and listing done." },
    ]);

    const result = await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "Search then list." },
      makeOptions({ generate }, { maxToolRounds: 2 }),
    );

    expect(result.state.toolRounds).toBe(2);
    expect(result.state.toolResults).toEqual([
      { ok: true, callId: "s", data: [] },
      { ok: true, callId: "t", data: homeListing("/tmp") },
    ]);
    expect(result.state.messages).toHaveLength(3);

    // Round 1 committed its message via begin; round 2 via append.
    expect(mocks.beginAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.appendAgentTurnRoundMessage).toHaveBeenCalledTimes(1);
    expect(mocks.appendAgentTurnRoundMessage).toHaveBeenCalledWith({
      userId: USER_ID,
      conversationId: "conv-1",
      toolCalls: [call("t", "list_directory", { path: "/tmp" })],
    });

    // Each round's results are attached to the EXACT message that owned it.
    expect(mocks.completeAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: "conv-1",
        rounds: [
          {
            messageId: "msg-r1",
            toolResults: [{ ok: true, callId: "s", data: [] }],
          },
          {
            messageId: "msg-r2",
            toolResults: [{ ok: true, callId: "t", data: homeListing("/tmp") }],
          },
        ],
        finalText: "Search and listing done.",
      }),
    );
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("persists a text-only turn with no tool rounds", async () => {
    const { generate } = scriptedProvider([{ text: "No tools needed." }]);

    const result = await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "Hello." },
      makeOptions({ generate }),
    );

    expect(result.state.toolRounds).toBe(0);
    expect(result.state.finalText).toBe("No tools needed.");
    expect(result.state.messages).toEqual([{ kind: "final", text: "No tools needed." }]);

    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        rounds: [],
        finalText: "No tools needed.",
        maxToolRounds: 1,
      }),
    );
    expect(mocks.beginAgentTurn).not.toHaveBeenCalled();
    expect(mocks.completeAgentTurn).not.toHaveBeenCalled();
  });
it("stops at the round limit, never executes the extra tools, and compensates the eager rows", async () => {
    const { generate } = scriptedProvider([
      { toolCalls: [call("a", "search_files", { query: "x" })] },
      { toolCalls: [call("b", "search_files", { query: "y" })] },
      { toolCalls: [call("c", "search_files", { query: "z" })] },
    ]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { instruction: "keep going" },
        makeOptions({ generate }, { maxToolRounds: 2 }),
      ),
    ).rejects.toMatchObject({
      name: "AgentLoopError",
      code: "agent/max-tool-rounds-reached",
    });

    // Rounds 1 + 2 were executed and eagerly persisted, round 3 never ran.
    expect(mocks.beginAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.appendAgentTurnRoundMessage).toHaveBeenCalledTimes(1);
    // No complete (the turn failed) and no atomic write.
    expect(mocks.completeAgentTurn).not.toHaveBeenCalled();
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
    // Compensation removes the new conversation's eager rows (cascade).
    expect(mocks.cancelAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.cancelAgentTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      conversationId: "conv-1",
      created: true,
      messageIds: ["inst-1", "msg-r1", "msg-r2"],
    });
  });
});

// ---------------------------------------------------------------------------
// 5 & 6. Ownership and provider failure — no invalid partial state
// ---------------------------------------------------------------------------

describe("runPersistentTurn — failures leave no partial state", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("propagates a typed provider failure before any eager commit and persists nothing", async () => {
    const { generate } = scriptedProvider([
      ProviderError.transient(ProviderErrorCode.RateLimited, "slow down"),
    ]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { instruction: "do something" },
        makeOptions({ generate }),
      ),
    ).rejects.toThrow(ProviderError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
    expect(mocks.beginAgentTurn).not.toHaveBeenCalled();
    expect(mocks.cancelAgentTurn).not.toHaveBeenCalled();
  });

  it("compensates a provider failure that happens AFTER a tool round already ran", async () => {
    const { generate } = scriptedProvider([
      { toolCalls: [call("a", "search_files", { query: "x" })] },
      ProviderError.transient(ProviderErrorCode.RateLimited, "slow down"),
    ]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { instruction: "do something" },
        makeOptions({ generate }, { maxToolRounds: 2 }),
      ),
    ).rejects.toThrow(ProviderError);

    // The first round's eager rows were committed, then compensated away.
    expect(mocks.beginAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.completeAgentTurn).not.toHaveBeenCalled();
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
    expect(mocks.cancelAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.cancelAgentTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      conversationId: "conv-1",
      created: true,
      messageIds: ["inst-1", "msg-r1"],
    });
  });

  it("rolls a failed resumed turn back to the conversation's prior state", async () => {
    let previous = createConversationState({ instruction: "First turn", maxToolRounds: 3 });
    previous = finalizeConversation(previous, "First reply.");
    mocks.loadAgentConversationState.mockResolvedValue(previous);
    mocks.beginAgentTurn.mockResolvedValue({
      conversationId: "conv-9",
      created: false,
      instructionMessageId: "inst-9",
      messageId: "msg-r1",
    });

    const { generate } = scriptedProvider([
      { toolCalls: [call("a", "search_files", { query: "x" })] },
      ProviderError.permanent(ProviderErrorCode.InvalidResponse, "garbage"),
    ]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { conversationId: "conv-9", instruction: "again" },
        makeOptions({ generate }, { maxToolRounds: 2 }),
      ),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });

    // Only this turn's messages are removed; the conversation row survives.
    expect(mocks.cancelAgentTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      conversationId: "conv-9",
      created: false,
      messageIds: ["inst-9", "msg-r1"],
    });
  });

  it("rejects a degraded provider with no final text and leaves nothing behind", async () => {
    const { generate } = scriptedProvider([{}] as AgentResponse[]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { instruction: "say something" },
        makeOptions({ generate }),
      ),
    ).rejects.toThrow(TypeError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
    expect(mocks.beginAgentTurn).not.toHaveBeenCalled();
    expect(mocks.cancelAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. Phase 10.28C-prep: persistence ordering + invocation-bound context
// ---------------------------------------------------------------------------

describe("runPersistentTurn — escalated tool context (10.28C-prep)", () => {
  beforeEach(() => {
    resetPersistenceMocks();
  });

  it("persists each round's assistant message BEFORE its tools execute", async () => {
    const events: string[] = [];
    mocks.beginAgentTurn.mockImplementation(async () => {
      events.push("persist:begin");
      return {
        conversationId: "conv-1",
        created: true,
        instructionMessageId: "inst-1",
        messageId: "msg-r1",
      };
    });
    mocks.appendAgentTurnRoundMessage.mockImplementation(async () => {
      events.push("persist:append");
      return { messageId: "msg-r2" };
    });
    mocks.completeAgentTurn.mockImplementation(async () => {
      events.push("persist:complete");
    });

    const { generate } = scriptedProvider([
      { toolCalls: [call("s", "search_files", { query: "notes" })] },
      { toolCalls: [call("t", "list_directory", { path: "/tmp" })] },
      { text: "done" },
    ]);

    await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "Search then list." },
      makeOptions({ generate }, { maxToolRounds: 2, filesystem: makeFilesystem(events) }),
    );

    // Both rounds persisted BEFORE their executor call; the completion write
    // happens only after the loop ends (execution of both tools succeeded).
    expect(events).toEqual([
      "persist:begin",
      "exec:searchFiles",
      "persist:append",
      "exec:listDirectory",
      "persist:complete",
    ]);
  });

  it("threads the persisted conversationId and per-round messageId to the tool policy boundary", async () => {
    const seen: ToolExecutionContext[] = [];
    const capturingPolicy: ToolPolicy = (definition, context) => {
      seen.push(context);
      return defaultToolPolicy()(definition, context);
    };

    const { generate } = scriptedProvider([
      { toolCalls: [call("s", "search_files", { query: "notes" })] },
      { toolCalls: [call("t", "list_directory", { path: "/tmp" })] },
      { text: "done" },
    ]);

    await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "Search then list." },
      makeOptions({ generate }, { maxToolRounds: 2, policy: capturingPolicy }),
    );

    // The policy runs once per tool call, at the invocation boundary, with
    // the persisted context bound per round.
    expect(seen.map((context) => [context.conversationId, context.messageId])).toEqual([
      ["conv-1", "msg-r1"],
      ["conv-1", "msg-r2"],
    ]);
    // Authenticated identity is preserved (never replaced by the context ids).
    for (const context of seen) {
      expect(context.actor.kind).toBe("ai-agent");
      if (context.actor.kind === "ai-agent") {
        expect(context.actor.identity.userId).toBe(USER_ID);
      }
    }
  });
});