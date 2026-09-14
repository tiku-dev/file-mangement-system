/**
 * Agent conversation / state contract tests (Phase 10.6).
 *
 * These tests prove the immutable conversation state model:
 *
 *   1. State creation (instruction + bound, no messages/results yet).
 *   2. Valid updates: recording provider turns and tool results.
 *   3. Tool-call → result progression across rounds.
 *   4. Final response finalization.
 *   5. Invalid transitions (recording after completion, malformed input).
 *   6. Round-limit queries (remaining rounds, completion).
 */
import { describe, expect, it } from "vitest";

import type { AgentToolCall, AgentToolResult } from "./agent.js";
import { ToolError, ToolErrorCode } from "../tools/errors.js";
import {
  createConversationState,
  finalizeConversation,
  isConversationComplete,
  recordProviderTurn,
  recordToolResults,
  remainingToolRounds,
  type AgentMessage,
  type ConversationState,
} from "./conversation.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

function okResult(callId: string, data: unknown): AgentToolResult {
  return { ok: true, callId, data };
}

function errResult(callId: string): AgentToolResult {
  return {
    ok: false,
    callId,
    error: new ToolError("not_found", ToolErrorCode.FilesystemNotFound, "missing"),
  };
}

function makeState(maxToolRounds = 3, instruction = "list my home"): ConversationState {
  return createConversationState({ instruction, maxToolRounds });
}

// ---------------------------------------------------------------------------
// 1. State creation
// ---------------------------------------------------------------------------

describe("ConversationState — creation", () => {
  it("creates an empty, immutable conversation with instruction and bound", () => {
    const state = makeState(4, "find notes");

    expect(state.instruction).toBe("find notes");
    expect(state.maxToolRounds).toBe(4);
    expect(state.messages).toEqual([]);
    expect(state.toolResults).toEqual([]);
    expect(state.toolRounds).toBe(0);
    expect(state.finalText).toBeUndefined();
    expect(isConversationComplete(state)).toBe(false);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.messages)).toBe(true);
    expect(Object.isFrozen(state.toolResults)).toBe(true);
  });

  it("rejects a non-empty-absence instruction and a non-positive bound", () => {
    expect(() => createConversationState({ instruction: "", maxToolRounds: 3 })).toThrow(
      TypeError,
    );
    expect(() =>
      createConversationState({ instruction: 42 as unknown as string, maxToolRounds: 3 }),
    ).toThrow(TypeError);
    expect(() => createConversationState({ instruction: "hi", maxToolRounds: 0 })).toThrow(
      TypeError,
    );
    expect(() => createConversationState({ instruction: "hi", maxToolRounds: 2.5 })).toThrow(
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Valid updates
// ---------------------------------------------------------------------------

describe("ConversationState — valid updates", () => {
  it("records a provider text turn without mutating the input state", () => {
    const initial = makeState();
    const updated = recordProviderTurn(initial, { text: "Working on it." });

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]).toEqual({ kind: "provider", text: "Working on it." });
    expect(updated.toolRounds).toBe(0);
    expect(updated.finalText).toBeUndefined();

    // The original state is untouched (immutability).
    expect(initial.messages).toEqual([]);
  });

  it("records a provider tool-call turn with validated intents", () => {
    const state = makeState();
    const updated = recordProviderTurn(state, {
      toolCalls: [
        call("c1", "list_directory", { path: "/home" }),
        call("c2", "search_files", { query: "notes" }),
      ],
    });

    expect(updated.messages).toHaveLength(1);
    const message = updated.messages[0];
    expect(message).toBeDefined();
    if (!message) return;
    expect(message.kind).toBe("provider");
    if (message.kind === "final") return;
    expect(message.toolCalls).toHaveLength(2);
  });

  it("records the structured results of an executed round and increments the counter", () => {
    let state = makeState();
    state = recordProviderTurn(state, { toolCalls: [call("c1", "list_directory", { path: "/home" })] });
    const after = recordToolResults(state, [
      okResult("c1", { path: "/home" }),
    ]);

    expect(after.toolRounds).toBe(1);
    expect(after.toolResults).toEqual([okResult("c1", { path: "/home" })]);
    expect(isConversationComplete(after)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Tool-call → result progression
// ---------------------------------------------------------------------------

describe("ConversationState — tool-call/result progression", () => {
  it("proceeds through multiple rounds with accumulating results", () => {
    let state = makeState(3, "list /home then search notes");
    const results: AgentToolResult[] = [];

    // Round 1: provider requests a tool, results come back.
    state = recordProviderTurn(state, {
      text: "Checking /home.",
      toolCalls: [call("a", "list_directory", { path: "/home" })],
    });
    state = recordToolResults(state, [okResult("a", { path: "/home", items: [] })]);

    // Round 2: provider requests another tool.
    state = recordProviderTurn(state, {
      toolCalls: [call("b", "search_files", { query: "notes" })],
    });
    state = recordToolResults(state, [okResult("b", [])]);

    expect(state.toolRounds).toBe(2);
    expect(state.toolResults).toHaveLength(2);
    expect(state.messages).toHaveLength(2);
    expect(results).toEqual([]); // helper var; asserts we tracked nothing extra
  });

  it("carries failing tool results through without aborting progression", () => {
    let state = makeState();
    state = recordProviderTurn(state, { toolCalls: [call("a", "search_files", { query: "x" })] });
    state = recordToolResults(state, [errResult("a")]);

    expect(state.toolRounds).toBe(1);
    expect(state.toolResults[0]).toMatchObject({ ok: false, callId: "a" });
  });

  it("exposes the full typed transcript after progression", () => {
    let state = makeState(2);
    state = recordProviderTurn(state, { text: "Searching...", toolCalls: [call("a", "search_files", { query: "x" })] });
    state = recordToolResults(state, [okResult("a", [])]);
    state = finalizeConversation(state, "Found 0 matches.");

    const messages: readonly AgentMessage[] = state.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: "provider", text: "Searching..." });
    expect(messages[1]).toEqual({ kind: "final", text: "Found 0 matches." });
  });
});

// ---------------------------------------------------------------------------
// 4. Final response
// ---------------------------------------------------------------------------

describe("ConversationState — final response", () => {
  it("finalizes with a terminal final message and sets finalText", () => {
    const state = makeState();
    const done = finalizeConversation(state, "All done.");

    expect(done.finalText).toBe("All done.");
    expect(isConversationComplete(done)).toBe(true);
    expect(done.messages).toHaveLength(1);
    expect(done.messages[0]).toEqual({ kind: "final", text: "All done." });
    expect(state.finalText).toBeUndefined(); // original untouched
  });

  it("can finalize directly after tool rounds completed", () => {
    let state = makeState(2);
    state = recordProviderTurn(state, { toolCalls: [call("a", "list_directory", { path: "/home" })] });
    state = recordToolResults(state, [okResult("a", { path: "/home", items: [] })]);
    state = finalizeConversation(state, "3 items found.");

    expect(state.finalText).toBe("3 items found.");
    expect(state.toolRounds).toBe(1);
    expect(isConversationComplete(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Invalid transitions & malformed input
// ---------------------------------------------------------------------------

describe("ConversationState — invalid transitions", () => {
  it("rejects recording a provider turn after completion", () => {
    const done = finalizeConversation(makeState(), "bye");
    expect(() => recordProviderTurn(done, { text: "again" })).toThrow(Error);
  });

  it("rejects recording tool results after completion", () => {
    const done = finalizeConversation(makeState(), "bye");
    expect(() => recordToolResults(done, [okResult("x", 1)])).toThrow(Error);
  });

  it("rejects finalizing an already-complete conversation", () => {
    const done = finalizeConversation(makeState(), "bye");
    expect(() => finalizeConversation(done, "twice")).toThrow(Error);
  });

  it("rejects a provider turn with neither text nor toolCalls", () => {
    expect(() => recordProviderTurn(makeState(), {})).toThrow(TypeError);
  });

  it("rejects malformed provider text", () => {
    expect(() => recordProviderTurn(makeState(), { text: 42 })).toThrow(TypeError);
    expect(() => recordProviderTurn(makeState(), { text: "" })).toThrow(TypeError);
  });

  it("rejects malformed provider tool-calls", () => {
    expect(() =>
      recordProviderTurn(makeState(), { toolCalls: "not-an-array" }),
    ).toThrow(TypeError);
    expect(() =>
      recordProviderTurn(makeState(), {
        toolCalls: [{ id: "c1", toolName: "" }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      recordProviderTurn(makeState(), {
        toolCalls: [{ id: "c1", toolName: "list_directory" }],
      }),
    ).toThrow(TypeError);
  });

  it("rejects malformed tool results", () => {
    expect(() => recordToolResults(makeState(), "nope")).toThrow(TypeError);
    expect(() => recordToolResults(makeState(), [{ nope: true }])).toThrow(TypeError);
  });

  it("rejects a malformed final text", () => {
    expect(() => finalizeConversation(makeState(), 42)).toThrow(TypeError);
    expect(() => finalizeConversation(makeState(), "")).toThrow(TypeError);
    expect(() => finalizeConversation(makeState(), undefined)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 6. Round limits
// ---------------------------------------------------------------------------

describe("ConversationState — round limits", () => {
  it("reports remaining tool rounds and exhausts at the bound", () => {
    let state = makeState(2);
    expect(remainingToolRounds(state)).toBe(2);

    state = recordProviderTurn(state, { toolCalls: [call("a", "list_directory", { path: "/home" })] });
    state = recordToolResults(state, [okResult("a", {})]);
    expect(remainingToolRounds(state)).toBe(1);

    state = recordProviderTurn(state, { toolCalls: [call("b", "search_files", { query: "x" })] });
    state = recordToolResults(state, [okResult("b", [])]);
    expect(remainingToolRounds(state)).toBe(0);
  });

  it("knows the loop bound without re-implementing loop logic", () => {
    const state = makeState(5);
    expect(state.maxToolRounds).toBe(5);
    expect(remainingToolRounds(state)).toBe(5);
  });
});