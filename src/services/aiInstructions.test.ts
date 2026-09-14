/**
 * AI instruction submission tests (Phase 10.22).
 *
 * These tests exercise the REAL service: strict body parsing/validation, the
 * injection of the EXISTING persistent agent-turn runtime, error mapping,
 * and the safe response shaping. The runtime is a scripted fake — no
 * provider, no network, no filesystem. Conversation state is built with the
 * real Phase 10.6 transitions.
 *
 * Coverage:
 *
 *   1. Strict body parsing (missing/empty/whitespace/oversized/type errors).
 *   2. conversationId validation (new vs resuming).
 *   3. Identity cannot be overridden by the body (unknown fields rejected).
 *   4. Delegation to the runtime (create + resume paths).
 *   5. Error mapping: foreign conversation, provider failure, fallback
 *      exhaustion, loop bound, AppError passthrough, unexpected raw errors.
 *   6. Safe response shape: transcript preserved, raw file payloads NEVER
 *      echoed, tool outcomes as `{ callId, ok }` only.
 *   7. Runtime binding seam (`bindAiInstructionRuntime`).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AppError } from "../core/errors.js";
import {
  createConversationState,
  finalizeConversation,
  recordProviderTurn,
  recordToolResults,
} from "./conversation.js";
import { AgentLoopError, isAgentLoopError } from "./agentLoop.js";
import { ProviderError, ProviderErrorCode } from "./provider.js";
import { ProviderFallbackError } from "./providerFallback.js";
import { AgentConversationNotFoundError } from "../database/repositories/agentConversations.js";
import type { PersistentAgentTurnRuntime, PersistentTurnResult } from "./persistentAgentTurn.js";
import {
  bindAiInstructionFilesystem,
  bindAiInstructionRuntime,
  MAX_INSTRUCTION_LENGTH,
  mapAgentTurnError,
  parseAiInstructionInput,
  runAiInstruction,
  runAiInstructionWithRuntime,
  toAiInstructionResponse,
  type AiInstructionBody,
  type AiInstructionResponse,
} from "./aiInstructions.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";

const ACTIVE_USER = {
  id: USER_ID,
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

function sessionContext(user: unknown = ACTIVE_USER): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

const VALID_INSTRUCTION = "List my home directory.";

function makeResult(
  overrides?: Partial<PersistentTurnResult> & {
    instruction?: string;
    toolCall?: { callId: string; name: string; args: Record<string, unknown> };
    toolData?: unknown;
    finalText?: string;
  },
): PersistentTurnResult {
  let state = createConversationState({
    instruction: overrides?.instruction ?? "List my home directory.",
    maxToolRounds: 3,
  });

  if (overrides?.toolCall !== undefined) {
    state = recordProviderTurn(state, {
      toolCalls: [
        {
          id: overrides.toolCall.callId,
          toolName: overrides.toolCall.name,
          input: overrides.toolCall.args,
        },
      ],
    });
    state = recordToolResults(state, [
      { ok: true, callId: overrides.toolCall.callId, data: overrides?.toolData ?? {} },
    ]);
  }

  const finalText = overrides?.finalText ?? "Everything listed.";
  state = finalizeConversation(state, finalText);

  return {
    conversationId: overrides?.conversationId ?? CONVERSATION_ID,
    created: overrides?.created ?? true,
    state,
    pendingApprovals: overrides?.pendingApprovals ?? [],
  };
}

function fakeRuntime(
  behavior: { result?: PersistentTurnResult; error?: unknown; run?: Mock },
): PersistentAgentTurnRuntime {
  const run =
    behavior.run ??
    vi.fn(async () => {
      if (behavior.error !== undefined) throw behavior.error;
      return behavior.result ?? makeResult();
    });
  return { run };
}

// ---------------------------------------------------------------------------
// 1 & 2. Strict body validation
// ---------------------------------------------------------------------------

describe("parseAiInstructionInput — strict body validation", () => {
  it("accepts a minimal valid instruction body", () => {
    const parsed = parseAiInstructionInput({ instruction: VALID_INSTRUCTION });
    expect(parsed).toEqual({ instruction: VALID_INSTRUCTION });
    expect(parsed.conversationId).toBeUndefined();
  });

  it("accepts a valid conversationId for resuming", () => {
    const body: AiInstructionBody = {
      conversationId: CONVERSATION_ID,
      instruction: VALID_INSTRUCTION,
    };
    expect(parseAiInstructionInput(body)).toEqual(body);
  });

  it("normalizes (trims) the instruction", () => {
    expect(parseAiInstructionInput({ instruction: "  hi there  " }).instruction).toBe("hi there");
  });

  it("rejects a missing instruction", () => {
    try {
      parseAiInstructionInput({});
      throw new Error("expected parse failure");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("common/bad-request");
    }
    expect(() => parseAiInstructionInput({ conversationId: CONVERSATION_ID })).toThrow(AppError);
  });

  it("rejects an empty instruction", () => {
    expect(() => parseAiInstructionInput({ instruction: "" })).toThrow(/not be empty/);
  });

  it("rejects a whitespace-only instruction", () => {
    expect(() => parseAiInstructionInput({ instruction: "   \n  " })).toThrow(/not be empty/);
  });

  it("rejects a non-string instruction", () => {
    expect(() => parseAiInstructionInput({ instruction: 42 })).toThrow(/must be a string/);
    expect(() => parseAiInstructionInput({ instruction: ["x"] })).toThrow(/must be a string/);
  });

  it("rejects an instruction over the maximum length", () => {
    const tooLong = "x".repeat(MAX_INSTRUCTION_LENGTH + 1);
    expect(() => parseAiInstructionInput({ instruction: tooLong })).toThrow(
      new RegExp(`at most ${MAX_INSTRUCTION_LENGTH} characters`),
    );
  });

  it("accepts an instruction exactly at the maximum length", () => {
    const exact = "x".repeat(MAX_INSTRUCTION_LENGTH);
    expect(parseAiInstructionInput({ instruction: exact }).instruction).toHaveLength(
      MAX_INSTRUCTION_LENGTH,
    );
  });

  it("rejects a non-uuid conversationId", () => {
    for (const bad of [
      "not-a-uuid",
      "22222222-2222-2222-2222-22222222222", // short
      "GGGGGGGG-2222-2222-2222-222222222222", // not hex
      42,
      "",
    ]) {
      expect(() => parseAiInstructionInput({ conversationId: bad, instruction: VALID_INSTRUCTION })).toThrow(
        /valid conversationId/,
      );
    }
  });

  it("rejects a non-object body", () => {
    for (const bad of [null, "string", 42, [], true]) {
      expect(() => parseAiInstructionInput(bad)).toThrow(/must be a JSON object/);
    }
  });

  // -----------------------------------------------------------------------
  // 3. Identity cannot be overridden by the body
  // -----------------------------------------------------------------------

  it("rejects ANY unexpected field, including body-supplied identity", () => {
    for (const body of [
      { instruction: VALID_INSTRUCTION, userId: "9".repeat(36) },
      { instruction: VALID_INSTRUCTION, user: "attacker" },
      { instruction: VALID_INSTRUCTION, provider: "grok" },
      { instruction: VALID_INSTRUCTION, conversationId: CONVERSATION_ID, title: "x" },
      { instruction: VALID_INSTRUCTION, context: { evil: true } },
    ]) {
      expect(() => parseAiInstructionInput(body)).toThrow(/Unexpected field/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Delegation to the existing runtime
// ---------------------------------------------------------------------------

describe("runAiInstructionWithRuntime — delegation", () => {
  it("executes a NEW conversation (no conversationId) through the runtime", async () => {
    const run = vi.fn().mockResolvedValue(makeResult());
    const runtime = fakeRuntime({ run });

    const response = await runAiInstructionWithRuntime(
      runtime,
      sessionContext(),
      { instruction: VALID_INSTRUCTION },
    );

    expect(run).toHaveBeenCalledTimes(1);
    const [c, input] = run.mock.calls[0]!;
    expect((c as { get: (k: string) => unknown }).get("user")).toBe(ACTIVE_USER);
    expect(input).toEqual({ instruction: VALID_INSTRUCTION });
    expect(response.conversationId).toBe(CONVERSATION_ID);
  });

  it("executes a RESUME path with the parsed conversationId", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ created: false, conversationId: CONVERSATION_ID }));
    const runtime = fakeRuntime({ run });

    const response = await runAiInstructionWithRuntime(
      runtime,
      sessionContext(),
      { conversationId: CONVERSATION_ID, instruction: VALID_INSTRUCTION },
    );

    const [, input] = run.mock.calls[0]!;
    expect(input).toEqual({
      conversationId: CONVERSATION_ID,
      instruction: VALID_INSTRUCTION,
    });
    expect(response.turn.created).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Error mapping
// ---------------------------------------------------------------------------

describe("runAiInstructionWithRuntime — error mapping", () => {
  it("maps a foreign / missing conversation to 404 common/not-found", async () => {
    const runtime = fakeRuntime({ error: new AgentConversationNotFoundError() });

    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(), { instruction: VALID_INSTRUCTION }),
    ).rejects.toMatchObject({
      status: 404,
      code: "common/not-found",
      message: "Agent conversation was not found.",
    });
  });

  it("maps a provider failure to 503 ai/provider-unavailable without leaks", async () => {
    const runtime = fakeRuntime({
      error: ProviderError.transient(ProviderErrorCode.Unavailable, "upstream 503 at internal host"),
    });

    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(), { instruction: VALID_INSTRUCTION }),
    ).rejects.toMatchObject({
      status: 503,
      code: "ai/provider-unavailable",
    });
  });

  it("maps all-providers-unavailable (fallback exhaustion) to 503", async () => {
    const fallback = new ProviderFallbackError([]);
    const mapped = mapAgentTurnError(fallback);
    expect(mapped).toMatchObject({ status: 503, code: "ai/provider-unavailable" });
  });

  it("maps the bounded-loop error to 502 ai/max-tool-rounds-reached", async () => {
    const loopError = new AgentLoopError(3);
    expect(isAgentLoopError(loopError)).toBe(true);
    const mapped = mapAgentTurnError(loopError);
    expect(mapped).toMatchObject({
      status: 502,
      code: "ai/max-tool-rounds-reached",
    });
  });

  it("proves the loop-bound error propagates through the runner as typed", async () => {
    const runtime = fakeRuntime({ error: new AgentLoopError(3) });

    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(), { instruction: VALID_INSTRUCTION }),
    ).rejects.toMatchObject({ status: 502, code: "ai/max-tool-rounds-reached" });
  });

  it("passes AppError through unchanged", async () => {
    const original = AppError.badRequest("Instruction must not be empty.");
    expect(mapAgentTurnError(original)).toBe(original);
  });

  it("leaves unexpected errors unchanged for the HTTP generic-envelope safety net", async () => {
    const secret = new Error("SECRET internal path /Users/me/… key=sk-LIVE-security-provider");
    expect(mapAgentTurnError(secret)).toBe(secret);
  });
});

// ---------------------------------------------------------------------------
// 6. Safe response shape
// ---------------------------------------------------------------------------

describe("toAiInstructionResponse — safe response shape", () => {
  it("returns the stable typed shape with scalar fields and transcript", () => {
    const result = makeResult({
      toolCall: { callId: "c1", name: "list_directory", args: { path: "/home" } },
      toolData: { path: "/home", parentPath: null, isHome: true, items: [{ name: "notes.txt" }] },
      finalText: "Everything listed.",
    });

    const response = toAiInstructionResponse(result);

    expect(Object.keys(response).sort()).toEqual(["conversationId", "turn"]);
    expect(Object.keys(response.turn).sort()).toEqual(
      ["created", "finalText", "instruction", "maxToolRounds", "messages", "pendingApprovals", "toolResults", "toolRounds"].sort(),
    );
    expect(response.conversationId).toBe(CONVERSATION_ID);
    expect(response.turn.instruction).toBe("List my home directory.");
    expect(response.turn.finalText).toBe("Everything listed.");
    expect(response.turn.toolRounds).toBe(1);
    expect(response.turn.maxToolRounds).toBe(3);
    expect(response.turn.created).toBe(true);
    // Transcript preserved for the file reference (the agent's own intent).
    expect(response.turn.messages).toEqual(result.state.messages);
  });

  it("reduces tool results to { callId, ok } and never echoes payloads", () => {
    const base64Content = Buffer.from("TOP SECRET FILE CONTENTS").toString("base64");
    const result = makeResult({
      toolCall: { callId: "read1", name: "read_file", args: { path: "/home/secret.txt" } },
      toolData: { encoding: "base64", data: base64Content },
    });

    const response = toAiInstructionResponse(result);

    expect(response.turn.toolResults).toEqual([{ callId: "read1", ok: true }]);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(base64Content);
    expect(serialized).not.toContain("TOP SECRET FILE CONTENTS");
    expect(serialized).not.toContain('"data"');
    expect(serialized).not.toContain('"ok":true,"data"');
  });

  it("surfaces failed tool outcomes (ok:false) without throwing", () => {
    let state = createConversationState({ instruction: "x", maxToolRounds: 3 });
    state = recordProviderTurn(state, {
      toolCalls: [{ id: "f1", toolName: "read_file", input: { path: "/missing.txt" } }],
    });
    state = recordToolResults(state, [
      { ok: false, callId: "f1", code: "filesystem/read-unauthorized" },
    ]);
    state = finalizeConversation(state, "I could not read that file.");

    const response = toAiInstructionResponse({
      conversationId: CONVERSATION_ID,
      created: true,
      state,
      pendingApprovals: [],
    });

    expect(response.turn.toolResults).toEqual([{ callId: "f1", ok: false }]);
    expect(response.turn.finalText).toBe("I could not read that file.");
    expect(JSON.stringify(response)).not.toContain("filesystem/read-unauthorized");
  });

  it("omits finalText when the turn has not produced one", () => {
    const state = createConversationState({ instruction: "x", maxToolRounds: 1 });
    const response = toAiInstructionResponse({
      conversationId: CONVERSATION_ID,
      created: true,
      state,
      pendingApprovals: [],
    });
    expect("finalText" in response.turn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Runtime binding seam + production entry
// ---------------------------------------------------------------------------

describe("runAiInstruction — runtime seam", () => {
  beforeEach(() => {
    bindAiInstructionRuntime(undefined);
    bindAiInstructionFilesystem(undefined);
  });

  afterEach(() => {
    bindAiInstructionRuntime(undefined);
    bindAiInstructionFilesystem(undefined);
  });

  it("uses a bound long-lived runtime when provided", async () => {
    const run = vi.fn().mockResolvedValue(makeResult());
    bindAiInstructionRuntime(fakeRuntime({ run }));

    const response = await runAiInstruction(sessionContext(), { instruction: VALID_INSTRUCTION });

    expect(run).toHaveBeenCalledTimes(1);
    expect(response.conversationId).toBe(CONVERSATION_ID);
  });

  it("produces a safe typed response through the full pipeline", async () => {
    const run = vi.fn().mockResolvedValue(makeResult());
    bindAiInstructionRuntime(fakeRuntime({ run }));

    const response: AiInstructionResponse = await runAiInstruction(
      sessionContext(),
      { instruction: VALID_INSTRUCTION },
    );

    expect(response.turn.created).toBe(true);
    expect(typeof response.conversationId).toBe("string");
    expect(Array.isArray(response.turn.messages)).toBe(true);
  });
});