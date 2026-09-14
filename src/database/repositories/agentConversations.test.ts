/**
 * Agent conversation repository tests (Phase 10.7).
 *
 * The Perspicuous Prisma client is mocked (`../client.js` → `getDatabase`)
 * with an in-memory fake so the repository runs without a database. Tests
 * cover:
 *
 *   1. createAgentConversation persisting ownership + bound + instruction.
 *   2. appendAgentTurn / appendAgentFinal round-tripping a full Phase 10.6
 *      state via loadAgentConversationState.
 *   3. Ownership enforcement on load and on append (foreign user is
 *      indistinguishable from "missing").
 *   4. Input validation gating writes (TypeError before any insert).
 *   5. reconstructConversationState as a pure replay function: turn resets,
 *      system rows ignored, serialized ToolErrors restored, corrupt rows
 *      rejected.
 *   6. Exact preservation of file_id / version_id references.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentConversationCorruptError,
  AgentConversationNotFoundError,
  appendAgentFinal,
  appendAgentTurn,
  appendAgentTurnRoundMessage,
  archiveAgentConversation,
  beginAgentTurn,
  cancelAgentTurn,
  completeAgentTurn,
  createAgentConversation,
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
  listConversationLastMessages,
  loadAgentConversationState,
  persistAgentTurn,
  reconstructConversationState,
  unarchiveAgentConversation,
} from "./agentConversations.js";
import { ToolError } from "../../tools/errors.js";
import type { AgentToolResult } from "../../services/agent.js";
import type { ConversationState } from "../../services/conversation.js";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
}));

vi.mock("../client.js", () => ({
  getDatabase: mocks.getDatabase,
}));

// ---------------------------------------------------------------------------
// In-memory fake Prisma client
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

const PRISMA_SORT_ASC = "asc" as const;
const PRISMA_SORT_DESC = "desc" as const;

/** In-memory equivalent of Prisma's `orderBy: [{ field: "asc" | "desc" }]`. */
function sortBy(rows: AnyRecord[], orderBy?: AnyRecord[]): AnyRecord[] {
  if (orderBy === undefined || orderBy.length === 0) {
    return [...rows];
  }
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      for (const [field, direction] of Object.entries(clause)) {
        const av = a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as string);
        const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as string);
        if (av < bv) return direction === PRISMA_SORT_ASC ? -1 : 1;
        if (av > bv) return direction === PRISMA_SORT_ASC ? 1 : -1;
      }
    }
    return 0;
  });
}

function createFakeDb() {
  const conversations: AnyRecord[] = [];
  const messages: AnyRecord[] = [];
  let convSeq = 0;
  let msgSeq = 0;

  const delegates = {
    aiConversation: {
      create: vi.fn(async ({ data }: { data: AnyRecord }) => {
        convSeq += 1;
        const row = {
          id: `conv-${convSeq}`,
          createdAt: new Date(1_700_000_000_000 + convSeq),
          updatedAt: new Date(1_700_000_000_000 + convSeq),
          archivedAt: null,
          ...data,
        };
        conversations.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where = {} }: { where?: AnyRecord }) => {
        const row = conversations.find(
          (c) =>
            (where.id === undefined || c.id === where.id) &&
            (where.userId === undefined || c.userId === where.userId),
        );
        return row ?? null;
      }),
      findFirstOrThrow: vi.fn(async ({ where = {} }: { where?: AnyRecord }) => {
        const row = conversations.find(
          (c) =>
            (where.id === undefined || c.id === where.id) &&
            (where.userId === undefined || c.userId === where.userId),
        );
        if (row === undefined) throw new Error(`Conversation not found (fake).`);
        return row;
      }),
      findMany: vi.fn(async ({ where = {}, orderBy }: { where?: AnyRecord; orderBy?: AnyRecord[] }) => {
        const titleFilter =
          where.title !== undefined && typeof where.title === "object" && where.title !== null
            ? (where.title as { contains?: unknown })
            : undefined;
        const rows = conversations.filter(
          (c) =>
            (where.userId === undefined || c.userId === where.userId) &&
            (where.archivedAt === undefined || c.archivedAt === where.archivedAt) &&
            (titleFilter === undefined ||
              titleFilter.contains === undefined ||
              // Mirrors Prisma `contains` + `mode: "insensitive"` (ILIKE).
              String(c.title ?? "").toLowerCase().includes(String(titleFilter.contains).toLowerCase())),
        );
        return sortBy(rows, orderBy);
      }),
      updateMany: vi.fn(async ({ where = {}, data }: { where?: AnyRecord; data: AnyRecord }) => {
        const matches = conversations.filter(
          (c) =>
            (where.id === undefined || c.id === where.id) &&
            (where.userId === undefined || c.userId === where.userId),
        );
        if (matches.length === 0) return { count: 0 };
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      }),
      deleteMany: vi.fn(async ({ where = {} }: { where?: AnyRecord }) => {
        const matches = conversations.filter(
          (c) =>
            (where.id === undefined || c.id === where.id) &&
            (where.userId === undefined || c.userId === where.userId),
        );
        if (matches.length === 0) return { count: 0 };
        for (const row of matches) {
          // Simulates the schema's ON DELETE CASCADE: deleting the
          // conversation deletes its transcript + conversation-scoped refs.
          for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message !== undefined && message.conversationId === row.id) {
              messages.splice(i, 1);
            }
          }
        }
        for (let i = conversations.length - 1; i >= 0; i--) {
          const conversation = conversations[i];
          if (conversation !== undefined && matches.includes(conversation)) {
            conversations.splice(i, 1);
          }
        }
        return { count: matches.length };
      }),
      update: vi.fn(async ({ where, data }: { where: AnyRecord; data: AnyRecord }) => {
        const row = conversations.find((c) => c.id === where.id);
        if (!row) throw new Error(`Conversation ${where.id} not found (fake).`);
        Object.assign(row, data);
        return row;
      }),
    },
    aiMessage: {
      create: vi.fn(async ({ data }: { data: AnyRecord }) => {
        msgSeq += 1;
        const row = {
          id: `msg-${msgSeq}`,
          isFinal: false,
          toolCalls: null,
          toolResults: null,
          ...data,
          createdAt: data.createdAt ?? new Date(1_700_000_000_000 + msgSeq),
        };
        messages.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({ where, orderBy }: { where?: AnyRecord; orderBy?: AnyRecord[] }) => {
          const idIn = (where?.conversationId as { in?: unknown[] } | undefined)?.in;
          const idEq = typeof where?.conversationId === "string" ? where.conversationId : undefined;
          const ownerId = (where?.conversation as { is?: { userId?: string } } | undefined)?.is
            ?.userId;
          const rows = messages.filter(
            (m) =>
              (idIn !== undefined
                ? idIn.includes(m.conversationId)
                : idEq === undefined || m.conversationId === idEq) &&
              (ownerId === undefined ||
                conversations.some((c) => c.id === m.conversationId && c.userId === ownerId)),
          );
          return sortBy(rows, orderBy);
        },
      ),
      update: vi.fn(async ({ where, data }: { where: AnyRecord; data: AnyRecord }) => {
        const row = messages.find((m) => m.id === where.id);
        if (row === undefined) throw new Error(`Message ${String(where.id)} not found (fake).`);
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(
        async ({ where = {}, data }: { where?: AnyRecord; data: AnyRecord }) => {
          const idFilter = where.id as string | { in?: unknown[] } | undefined;
          const idIn = typeof idFilter === "object" && idFilter !== null ? idFilter.in : undefined;
          const idEq = typeof idFilter === "string" ? idFilter : undefined;
          const matches = messages.filter(
            (m) =>
              (idIn !== undefined
                ? idIn.includes(m.id)
                : idEq === undefined || m.id === idEq) &&
              (where.conversationId === undefined || m.conversationId === where.conversationId),
          );
          for (const row of matches) Object.assign(row, data);
          return { count: matches.length };
        },
      ),
      deleteMany: vi.fn(
        async ({ where = {} }: { where?: AnyRecord }) => {
          const idIn = (where.id as { in?: unknown[] } | undefined)?.in;
          const matches = messages.filter(
            (m) =>
              (idIn === undefined || idIn.includes(m.id)) &&
              (where.conversationId === undefined || m.conversationId === where.conversationId),
          );
          if (matches.length === 0) return { count: 0 };
          for (const row of matches) {
            const idx = messages.indexOf(row);
            if (idx !== -1) messages.splice(idx, 1);
          }
          return { count: matches.length };
        },
      ),
    },
    $transaction: vi.fn(async (fn: (tx: typeof delegates) => Promise<unknown>) => {
      return await fn(delegates);
    }),
  };
  return { delegates, conversations, messages };
}

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function agentStateMatchers(state: ConversationState) {
  return {
    instruction: state.instruction,
    messageCount: state.messages.length,
    toolRounds: state.toolRounds,
    toolResults: state.toolResults,
    finalText: state.finalText,
    remaining: state.maxToolRounds - state.toolRounds,
  };
}

describe("agentConversations repository", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    db = createFakeDb();
    mocks.getDatabase.mockReturnValue(db.delegates);
  });

  describe("createAgentConversation", () => {
    it("persists ownership, bound, and the instruction message", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "Summarize the invoices.",
        maxToolRounds: 3,
        title: "Invoice summary",
      });

      expect(created.userId).toBe(ALICE);
      expect(created.maxToolRounds).toBe(3);
      expect(created.title).toBe("Invoice summary");
      expect(db.conversations).toHaveLength(1);
      expect(db.conversations[0]).toMatchObject({ userId: ALICE, maxToolRounds: 3 });
      expect(db.messages[0]).toMatchObject({
        conversationId: created.id,
        role: "user",
        content: "Summarize the invoices.",
      });
    });

    it("rejects an invalid bound before writing anything", async () => {
      await expect(
        createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 0 }),
      ).rejects.toThrow(TypeError);
      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it("rejects an empty instruction before writing anything", async () => {
      await expect(
        createAgentConversation({ userId: ALICE, instruction: "", maxToolRounds: 2 }),
      ).rejects.toThrow(TypeError);
      expect(db.conversations).toHaveLength(0);
    });
  });

  describe("loadAgentConversationState round-trip", () => {
    it("returns a fresh state right after creation", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "List large files.",
        maxToolRounds: 2,
      });
      const state = await loadAgentConversationState(ALICE, created.id);

      expect(state).not.toBeNull();
      expect(agentStateMatchers(state as ConversationState)).toEqual({
        instruction: "List large files.",
        messageCount: 0,
        toolRounds: 0,
        toolResults: [],
        finalText: undefined,
        remaining: 2,
      });
    });

    it("replays appended provider rounds and the final reply", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "Find my spreadsheets.",
        maxToolRounds: 2,
      });
      const calls = [{ id: "call-1", toolName: "read_file_metadata", input: { path: "/a.xlsx" } }];
      await appendAgentTurn(ALICE, created.id, {
        text: "Looking…",
        toolCalls: calls,
        toolResults: [{ ok: true, callId: "call-1", data: { rows: 42 } }],
      });
      await appendAgentFinal(ALICE, created.id, "Found one spreadsheet.");

      const state = (await loadAgentConversationState(ALICE, created.id)) as ConversationState;
      expect(agentStateMatchers(state)).toEqual({
        instruction: "Find my spreadsheets.",
        messageCount: 2,
        toolRounds: 1,
        toolResults: [{ ok: true, callId: "call-1", data: { rows: 42 } }],
        finalText: "Found one spreadsheet.",
        remaining: 1,
      });
      const first = state.messages[0];
      if (!first) throw new Error("expected a provider message");
      expect(first.kind).toBe("provider");
      if (first.kind === "provider") {
        expect(first.text).toBe("Looking…");
        expect(first.toolCalls).toHaveLength(1);
      }
      expect(state.messages[1]).toEqual({ kind: "final", text: "Found one spreadsheet." });
    });

    it("preserves exact file_id / version_id references verbatim", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Analyze", maxToolRounds: 1 });
      const fileId = "f0000000-0000-0000-0000-0000000000f0";
      const versionId = "v0000000-0000-0000-0000-0000000000v0";
      const calls = [
        { id: "c1", toolName: "read_file", input: { fileId, versionId, only: ["summary"] } },
      ];
      await appendAgentTurn(ALICE, created.id, { toolCalls: calls });
      await appendAgentFinal(ALICE, created.id, "Done.");

      const state = (await loadAgentConversationState(ALICE, created.id)) as ConversationState;
      const provider = state.messages[0];
      if (!provider || provider.kind !== "provider" || provider.toolCalls === undefined) {
        throw new Error("expected a provider message with tool calls");
      }
      expect(provider.toolCalls[0]).toEqual({ id: "c1", toolName: "read_file", input: { fileId, versionId, only: ["summary"] } });
    });

    it("restores a serialized ToolError to a real instance", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Analyze", maxToolRounds: 1 });
      await appendAgentTurn(ALICE, created.id, {
        toolCalls: [{ id: "c1", toolName: "read_file", input: { path: "/nope" } }],
        toolResults: [
          {
            ok: false,
            callId: "c1",
            error: ToolError.notFound("filesystem/not-found", "No such file."),
          },
        ],
      });

      const state = (await loadAgentConversationState(ALICE, created.id)) as ConversationState;
      expect(state.toolResults).toHaveLength(1);
      const result = state.toolResults[0];
      if (!result || result.ok !== false) throw new Error("expected a failed result");
      expect(result.error).toBeInstanceOf(ToolError);
      expect(result.error.code).toBe("filesystem/not-found");
      expect(result.error.category).toBe("not_found");
    });

    it("bumps updated_at when appending", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      const before = created.updatedAt.getTime();
      await appendAgentFinal(ALICE, created.id, "Bye.");
      const stored = db.conversations[0];
      if (!stored) throw new Error("expected a stored conversation");
      expect((stored.updatedAt as Date).getTime()).toBeGreaterThan(before);
    });
  });

  describe("ownership enforcement", () => {
    it("returns null for a foreign owner on load", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Private", maxToolRounds: 1 });
      expect(await loadAgentConversationState(BOB, created.id)).toBeNull();
    });

    it("returns null for an unknown conversation id", async () => {
      expect(
        await loadAgentConversationState(ALICE, "00000000-0000-0000-0000-000000000000"),
      ).toBeNull();
    });

    it("throws not-found for a foreign owner on append", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Private", maxToolRounds: 1 });
      await expect(appendAgentTurn(BOB, created.id, { text: "sneak" })).rejects.toThrow(
        AgentConversationNotFoundError,
      );
      expect(db.messages).toHaveLength(1);
    });

    it("throws not-found for a foreign owner on final", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Private", maxToolRounds: 1 });
      await expect(appendAgentFinal(BOB, created.id, "done")).rejects.toThrow(
        AgentConversationNotFoundError,
      );
    });
  });

  describe("input gating", () => {
    it("rejects malformed tool calls before writing", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      const before = db.messages.length;
      await expect(
        appendAgentTurn(ALICE, created.id, { toolCalls: [{ id: "c1", toolName: "", input: {} }] }),
      ).rejects.toThrow(TypeError);
      expect(db.messages.length).toBe(before);
    });

    it("rejects a turn with neither text nor tool calls", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      await expect(appendAgentTurn(ALICE, created.id, {})).rejects.toThrow(TypeError);
      expect(db.messages).toHaveLength(1);
    });

    it("rejects an empty final response", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      await expect(appendAgentFinal(ALICE, created.id, "")).rejects.toThrow(TypeError);
      expect(db.messages).toHaveLength(1);
    });

    it("rejects malformed tool results before writing", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      await expect(
        appendAgentTurn(ALICE, created.id, {
          text: "ok",
          toolResults: [{ callId: 42 } as unknown as AgentToolResult],
        }),
      ).rejects.toThrow(TypeError);
      expect(db.messages).toHaveLength(1);
    });
  });

  describe("reconstructConversationState (pure)", () => {
    it("replays a provider round and final via stored rows", () => {
      const state = reconstructConversationState(2, [
        { role: "user", content: "Go", isFinal: false, createdAt: new Date(1000) },
        {
          role: "assistant",
          content: "working",
          isFinal: false,
          createdAt: new Date(2000),
          toolCalls: [{ id: "c1", toolName: "list_files", input: {} }],
          toolResults: [{ ok: true, callId: "c1", data: [] }],
        },
        { role: "assistant", content: "Finished", isFinal: true, createdAt: new Date(3000) },
      ]);
      expect(agentStateMatchers(state)).toEqual({
        instruction: "Go",
        messageCount: 2,
        toolRounds: 1,
        toolResults: [{ ok: true, callId: "c1", data: [] }],
        finalText: "Finished",
        remaining: 1,
      });
    });

    it("replays messages ordered by created_at even when stored shuffled", () => {
      const state = reconstructConversationState(1, [
        { role: "assistant", content: "Done", isFinal: true, createdAt: new Date(3000) },
        { role: "assistant", content: "busy", isFinal: false, createdAt: new Date(2000), toolCalls: [{ id: "c1", toolName: "stat", input: {} }] },
        { role: "user", content: "Proceed", isFinal: false, createdAt: new Date(1000) },
      ]);
      const first = state.messages[0];
      if (!first) throw new Error("expected a provider message");
      expect(first.kind).toBe("provider");
      expect(state.finalText).toBe("Done");
    });

    it("treats system rows as non-transcript noise", () => {
      const state = reconstructConversationState(1, [
        { role: "system", content: "You are helpful.", isFinal: false, createdAt: new Date(500) },
        { role: "user", content: "Proceed", isFinal: false, createdAt: new Date(1000) },
        { role: "assistant", content: "Done", isFinal: true, createdAt: new Date(2000) },
      ]);
      expect(state.instruction).toBe("Proceed");
      expect(agentStateMatchers(state).messageCount).toBe(1);
    });

    it("starts a new turn at a later user row", () => {
      const state = reconstructConversationState(2, [
        { role: "user", content: "First", isFinal: false, createdAt: new Date(1000) },
        { role: "assistant", content: "One", isFinal: true, createdAt: new Date(2000) },
        { role: "user", content: "Second", isFinal: false, createdAt: new Date(3000) },
        { role: "assistant", content: "Two", isFinal: true, createdAt: new Date(4000) },
      ]);
      expect(agentStateMatchers(state)).toEqual({
        instruction: "Second",
        messageCount: 1,
        toolRounds: 0,
        toolResults: [],
        finalText: "Two",
        remaining: 2,
      });
    });

    it("rejects an assistant message before any instruction", () => {
      expect(() =>
        reconstructConversationState(1, [
          { role: "assistant", content: "orphan", isFinal: false, createdAt: new Date(1000) },
        ]),
      ).toThrow(AgentConversationCorruptError);
    });

    it("rejects an empty transcript", () => {
      expect(() => reconstructConversationState(1, [])).toThrow(AgentConversationCorruptError);
    });

    it("rejects malformed stored tool calls", () => {
      expect(() =>
        reconstructConversationState(1, [
          { role: "user", content: "Go", isFinal: false, createdAt: new Date(1000) },
          {
            role: "assistant",
            content: "",
            isFinal: false,
            createdAt: new Date(2000),
            toolCalls: [{ id: 7 }],
          },
        ]),
      ).toThrow(AgentConversationCorruptError);
    });

    it("rejects a final message that never completed a turn after final", () => {
      expect(() =>
        reconstructConversationState(1, [
          { role: "user", content: "Go", isFinal: false, createdAt: new Date(1000) },
          { role: "assistant", content: "One", isFinal: true, createdAt: new Date(2000) },
          { role: "assistant", content: "Two", isFinal: true, createdAt: new Date(3000) },
        ]),
      ).toThrow(AgentConversationCorruptError);
    });
  });

  describe("persistAgentTurn (atomic)", () => {
    it("creates a conversation and writes instruction, rounds, and final in one transaction", async () => {
      const result = await persistAgentTurn({
        userId: ALICE,
        instruction: "List my docs.",
        maxToolRounds: 2,
        title: "Docs listing",
        rounds: [
          {
            text: "Looking…",
            toolCalls: [{ id: "c1", toolName: "list_directory", input: { path: "/home" } }],
            toolResults: [{ ok: true, callId: "c1", data: { items: [] } }],
          },
        ],
        finalText: "Here they are.",
      });

      expect(result.created).toBe(true);
      expect(result.id).toBeDefined();
      expect(db.conversations).toHaveLength(1);
      expect(db.conversations[0]).toMatchObject({
        userId: ALICE,
        maxToolRounds: 2,
        title: "Docs listing",
      });
      expect(db.messages).toHaveLength(3);
      expect(db.messages.map((m) => [m.role, m.content, m.isFinal])).toEqual([
        ["user", "List my docs.", false],
        ["assistant", "Looking…", false],
        ["assistant", "Here they are.", true],
      ]);
    });

    it("writes rows with strictly increasing created_at so the transcript is ordered", async () => {
      await persistAgentTurn({
        userId: ALICE,
        instruction: "Go",
        maxToolRounds: 2,
        rounds: [
          { toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }], toolResults: [{ ok: true, callId: "c1", data: null }] },
          { toolCalls: [{ id: "c2", toolName: "list_directory", input: {} }], toolResults: [{ ok: true, callId: "c2", data: null }] },
        ],
        finalText: "Done.",
      });

      const times = db.messages.map((m) => (m.createdAt as Date).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size).toBe(times.length);
    });

    it("appends a new turn when resuming an owned conversation", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "First turn",
        maxToolRounds: 2,
      });
      const before = db.messages.length;

      const result = await persistAgentTurn({
        userId: ALICE,
        conversationId: created.id,
        instruction: "Second turn",
        maxToolRounds: 5,
        rounds: [{ text: "thinking", toolResults: [] }],
        finalText: "Second reply.",
      });

      expect(result.created).toBe(false);
      expect(result.id).toBe(created.id);
      expect(db.messages.length).toBe(before + 3);
      expect(db.conversations).toHaveLength(1);

      const state = (await loadAgentConversationState(ALICE, created.id)) as ConversationState;
      expect(state.instruction).toBe("Second turn");
      expect(state.finalText).toBe("Second reply.");
    });

    it("rejects a foreign owner with not-found and writes nothing", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Private", maxToolRounds: 1 });
      const before = db.messages.length;

      await expect(
        persistAgentTurn({
          userId: BOB,
          conversationId: created.id,
          instruction: "sneak",
          maxToolRounds: 2,
          rounds: [],
          finalText: "Done.",
        }),
      ).rejects.toThrow(AgentConversationNotFoundError);
      expect(db.messages.length).toBe(before);
      expect(db.conversations).toHaveLength(1);
    });

    it("rejects an unknown conversation id with not-found", async () => {
      await expect(
        persistAgentTurn({
          userId: ALICE,
          conversationId: "00000000-0000-0000-0000-000000000000",
          instruction: "Hi",
          maxToolRounds: 2,
          rounds: [],
          finalText: "Done.",
        }),
      ).rejects.toThrow(AgentConversationNotFoundError);
      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it("validates every input before writing anything", async () => {
      const base = { userId: ALICE, maxToolRounds: 2, rounds: [], finalText: "Done." };

      await expect(
        persistAgentTurn({ ...base, instruction: "" }),
      ).rejects.toThrow(TypeError);
      await expect(
        persistAgentTurn({ ...base, instruction: "Hi", rounds: [{}] }),
      ).rejects.toThrow(TypeError);
      await expect(
        persistAgentTurn({ ...base, instruction: "Hi", finalText: "" }),
      ).rejects.toThrow(TypeError);
      await expect(
        persistAgentTurn({
          ...base,
          instruction: "Hi",
          rounds: [{ toolCalls: [{ id: "x", toolName: "", input: {} }] }],
        }),
      ).rejects.toThrow(TypeError);

      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it("preserves exact tool data in the created rows", async () => {
      const fileId = "f0000000-0000-0000-0000-0000000000f0";
      const versionId = "v0000000-0000-0000-0000-0000000000v0";
      await persistAgentTurn({
        userId: ALICE,
        instruction: "Analyze",
        maxToolRounds: 1,
        rounds: [
          {
            text: "idle",
            toolCalls: [{ id: "c1", toolName: "read_file", input: { fileId, versionId } }],
            toolResults: [{ ok: true, callId: "c1", data: { head: "ok" } }],
          },
        ],
        finalText: "Analyzed.",
      });
      const round = db.messages[1];
      if (!round) throw new Error("expected a persisted round");
      expect(round.toolCalls).toEqual([{ id: "c1", toolName: "read_file", input: { fileId, versionId } }]);
      expect(round.toolResults).toEqual([{ ok: true, callId: "c1", data: { head: "ok" } }]);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 10.23 read endpoints
  // ---------------------------------------------------------------------------

  describe("listAgentConversations", () => {
    async function seedConversation(
      userId: string,
      atMs: number,
      title?: string,
    ): Promise<string> {
      const created = await createAgentConversation({
        userId,
        instruction: `Instruction at ${atMs}`,
        maxToolRounds: 3,
        ...(title !== undefined ? { title } : {}),
      });
      // The fake bumps updatedAt through `bumpUpdatedAt`; force the ordering
      // timestamps directly so the test owns the clock.
      const row = db.conversations.find((c) => c.id === created.id);
      if (!row) throw new Error("expected a conversation row");
      row.createdAt = new Date(atMs);
      row.updatedAt = new Date(atMs);
      return created.id;
    }

    it("returns only the authenticated user's conversations", async () => {
      await seedConversation(ALICE, 1_705_000_000_001);
      await seedConversation(BOB, 1_705_000_000_002);

      const rows = await listAgentConversations(ALICE);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(ALICE);
    });

    it("orders the user's conversations newest-first (most recently updated)", async () => {
      await seedConversation(ALICE, 1_705_000_000_001);
      await seedConversation(ALICE, 1_705_000_000_003);
      await seedConversation(ALICE, 1_705_000_000_002);

      const rows = await listAgentConversations(ALICE);

      expect(rows.map((r) => r.updatedAt.getTime())).toEqual([
        1_705_000_000_003,
        1_705_000_000_002,
        1_705_000_000_001,
      ]);
    });

    it("returns a valid empty list for a user with no conversations", async () => {
      expect(await listAgentConversations(BOB)).toEqual([]);
    });

    it("exposes the conversation metadata fields deterministically", async () => {
      await seedConversation(ALICE, 1_705_000_000_001, "Invoices");

      const rows = await listAgentConversations(ALICE);

      expect(rows[0]).toMatchObject({
        title: "Invoices",
        maxToolRounds: 3,
      });
      expect(rows[0]?.createdAt).toEqual(new Date(1_705_000_000_001));
      expect(rows[0]?.updatedAt).toEqual(new Date(1_705_000_000_001));
      expect(typeof rows[0]?.id).toBe("string");
    });

    describe("— title search (Phase 10.27)", () => {
      it("filters by a case-insensitive title substring, newest-first", async () => {
        const quarterId = await seedConversation(ALICE, 1_705_000_000_001, "Quarterly report");
        const invoiceId = await seedConversation(ALICE, 1_705_000_000_002, "Invoice review");
        const energyId = await seedConversation(ALICE, 1_705_000_000_003, "Energy invoices");

        const rows = await listAgentConversations(ALICE, "invoice");

        // Partial ("invoices") + case-insensitive ("Invoice") matches; only
        // the non-matching "Quarterly report" is excluded. Order stays
        // deterministic newest-first.
        expect(rows.map((r) => r.id)).toEqual([energyId, invoiceId]);
        expect(rows.map((r) => r.id)).not.toContain(quarterId);
      });

      it("matches regardless of the query's letter case", async () => {
        const titleId = await seedConversation(ALICE, 1_705_000_000_001, "INVOICE REVIEW");

        const lower = await listAgentConversations(ALICE, "invoice");
        const upper = await listAgentConversations(ALICE, "INVOICE");

        expect(lower.map((r) => r.id)).toEqual([titleId]);
        expect(upper.map((r) => r.id)).toEqual([titleId]);
      });

      it("matches a partial substring anywhere in the title (contains)", async () => {
        const id = await seedConversation(ALICE, 1_705_000_000_001, "Plan the annual review");

        const rows = await listAgentConversations(ALICE, "nnu");

        expect(rows.map((r) => r.id)).toEqual([id]);
      });

      it("returns an empty list when no title matches", async () => {
        await seedConversation(ALICE, 1_705_000_000_001, "Invoice review");

        expect(await listAgentConversations(ALICE, "zebra")).toEqual([]);
      });

      it("only matches titles — message contents, tool results, and file references are never searched", async () => {
        const created = await createAgentConversation({
          userId: ALICE,
          instruction: "The invoice audit found issues in the vault.", // message content
          maxToolRounds: 3,
          title: "Plans",
        });
        await appendAgentTurn(ALICE, created.id, {
          text: "routes to vault://secret",
          toolCalls: [{ id: "c1", toolName: "read_file_metadata", input: { fileId: "f-1", versionId: "v-1" } }],
          toolResults: [
            { ok: true, callId: "c1", data: { name: "bill.pdf", sizeBytes: 5, contents: "S3CRET BODY" } },
          ],
        });

        expect(await listAgentConversations(ALICE, "invoice")).toEqual([]);
        expect(await listAgentConversations(ALICE, "vault")).toEqual([]);
        expect(await listAgentConversations(ALICE, "bill")).toEqual([]);
        expect(await listAgentConversations(ALICE, "S3CRET")).toEqual([]);
        // The conversation is still listed when its OWN title matches.
        const byTitle = await listAgentConversations(ALICE, "Plans");
        expect(byTitle.map((r) => r.id)).toEqual([created.id]);
      });

      it("is scoped to the caller — another user's matching title is never returned", async () => {
        const aliceId = await seedConversation(ALICE, 1_705_000_000_002, "Invoice review");
        const bobId = await seedConversation(BOB, 1_705_000_000_001, "Invoice review too");

        const asAlice = await listAgentConversations(ALICE, "invoice");
        const asBob = await listAgentConversations(BOB, "invoice");

        expect(asAlice.map((r) => r.id)).toEqual([aliceId]);
        expect(asBob.map((r) => r.id)).toEqual([bobId]);
      });

      it("excludes archived conversations from search results", async () => {
        const archivedId = await seedConversation(ALICE, 1_705_000_000_002, "Archived invoice");
        const activeId = await seedConversation(ALICE, 1_705_000_000_001, "Active invoice");
        await archiveAgentConversation(ALICE, archivedId, new Date(1_705_000_001_500));

        const rows = await listAgentConversations(ALICE, "invoice");

        expect(rows.map((r) => r.id)).toEqual([activeId]);
      });

      it("treats an empty title query like no query (defensive passthrough)", async () => {
        await seedConversation(ALICE, 1_705_000_000_001, "Invoice review");
        await seedConversation(ALICE, 1_705_000_000_002, "Quarterly report");

        const withQuery = await listAgentConversations(ALICE, "");
        const withoutQuery = await listAgentConversations(ALICE);

        expect(withQuery).toEqual(withoutQuery);
        expect(withQuery).toHaveLength(2);
      });
    });
  });

  describe("getAgentConversation", () => {
    async function seedWithMessages(): Promise<{ id: string; messageIds: string[] }> {
      const { id } = await persistAgentTurn({
        userId: ALICE,
        instruction: "List my files.",
        maxToolRounds: 2,
        rounds: [
          {
            text: "Looking…",
            toolCalls: [{ id: "c1", toolName: "list_directory", input: { path: "/home" } }],
            toolResults: [{ ok: true, callId: "c1", data: { items: [{ name: "notes.txt" }] } }],
          },
        ],
        finalText: "Done.",
      });
      return {
        id,
        messageIds: db.messages
          .filter((m) => m.conversationId === id)
          .map((m) => m.id as string),
      };
    }

    it("returns the owned conversation with its transcript in chronological order", async () => {
      const { id } = await seedWithMessages();

      const detail = await getAgentConversation(ALICE, id);

      expect(detail).not.toBeNull();
      expect(detail?.conversation.id).toBe(id);
      expect(detail?.conversation.userId).toBe(ALICE);
      expect(detail?.conversation.maxToolRounds).toBe(2);
      // user instruction -> provider round -> final reply
      expect(detail?.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "assistant",
      ]);
      expect(detail?.messages[0]?.content).toBe("List my files.");
      expect(detail?.messages[1]?.content).toBe("Looking…");
      expect(detail?.messages[2]?.content).toBe("Done.");
      expect(detail?.messages.map((m) => m.isFinal)).toEqual([false, false, true]);
    });

    it("preserves persisted structured tool data and exact references as stored", async () => {
      const { id } = await seedWithMessages();

      const detail = await getAgentConversation(ALICE, id);

      const round = detail?.messages[1];
      expect(round?.toolCalls).toEqual([{ id: "c1", toolName: "list_directory", input: { path: "/home" } }]);
      expect(round?.toolResults).toEqual([{ ok: true, callId: "c1", data: { items: [{ name: "notes.txt" }] } }]);
    });

    it("enforces ownership: a foreign conversation is indistinguishable from missing", async () => {
      const { id } = await seedWithMessages();

      const asForeign = await getAgentConversation(BOB, id);
      const asMissing = await getAgentConversation(BOB, "00000000-0000-0000-0000-000000000000");

      expect(asForeign).toBeNull();
      expect(asMissing).toBeNull();
    });

    it("ensures message ids are stable and rows are edge-ordered deterministically", async () => {
      const { id, messageIds } = await seedWithMessages();

      const detail = await getAgentConversation(ALICE, id);

      expect(detail?.messages.map((m) => m.id)).toEqual(messageIds);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 10.24 delete
  // ---------------------------------------------------------------------------

  describe("deleteAgentConversation", () => {
    async function seedOwned(): Promise<string> {
      const { id } = await persistAgentTurn({
        userId: ALICE,
        instruction: "List my files.",
        maxToolRounds: 2,
        rounds: [
          {
            text: "Looking…",
            toolCalls: [{ id: "c1", toolName: "read_file_metadata", input: {} }],
            toolResults: [
              {
                ok: true,
                callId: "c1",
                data: {
                  fileId: "f0000000-0000-0000-0000-0000000000f0",
                  versionId: "v0000000-0000-0000-0000-0000000000v0",
                  name: "bill.pdf",
                },
              },
            ],
          },
        ],
        finalText: "Done.",
      });
      return id;
    }

    it("deletes an owned conversation and ALL its associated persisted messages", async () => {
      const id = await seedOwned();
      const before = db.messages.filter((m) => m.conversationId === id);

      await expect(deleteAgentConversation(ALICE, id)).resolves.toBeUndefined();

      expect(before.length).toBeGreaterThanOrEqual(3);
      expect(db.conversations.find((c) => c.id === id)).toBeUndefined();
      expect(db.messages.filter((m) => m.conversationId === id)).toHaveLength(0);
    });

    it("deletes atomically through ONE owned-scoped statement (no manual cleanup)", async () => {
      const id = await seedOwned();

      await deleteAgentConversation(ALICE, id);

      expect(db.delegates.aiConversation.deleteMany).toHaveBeenCalledTimes(1);
      expect(db.delegates.aiConversation.deleteMany).toHaveBeenCalledWith({
        where: { id, userId: ALICE },
      });
      // No conversation row or its transcript is left behind.
      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it("is indistinguishable for a foreign and a missing conversation (404 contract)", async () => {
      const id = await seedOwned();

      const foreign = deleteAgentConversation(BOB, id).catch((e) => e);
      const missing = deleteAgentConversation(ALICE, "00000000-0000-0000-0000-000000000000").catch((e) => e);

      await expect(foreign).resolves.toBeInstanceOf(AgentConversationNotFoundError);
      await expect(missing).resolves.toBeInstanceOf(AgentConversationNotFoundError);
      // Nothing was deleted.
      expect(db.conversations.find((c) => c.id === id)).toBeDefined();
      expect(db.messages.filter((m) => m.conversationId === id)).toHaveLength(3);
    });

    it("treats a repeated deletion of an already-deleted conversation as missing (404 contract)", async () => {
      const id = await seedOwned();

      await expect(deleteAgentConversation(ALICE, id)).resolves.toBeUndefined();
      await expect(deleteAgentConversation(ALICE, id)).rejects.toBeInstanceOf(
        AgentConversationNotFoundError,
      );
    });

    it("never treats stored fileId/versionId references as deletion targets", async () => {
      const id = await seedOwned();
      // Sanity: the refs are persisted as metadata in the round row.
      const round = db.messages.find((m) => m.conversationId === id && m.toolResults !== null);
      expect(round?.toolResults).toEqual([
        { ok: true, callId: "c1", data: { fileId: "f0000000-0000-0000-0000-0000000000f0", versionId: "v0000000-0000-0000-0000-0000000000v0", name: "bill.pdf" } },
      ]);

      // Seeding used the transaction; only the delete should run afterwards.
      db.delegates.$transaction.mockClear();

      await deleteAgentConversation(ALICE, id);

      // Only the conversation delete happened — no file/file-version delete.
      expect(db.delegates.$transaction).not.toHaveBeenCalled();
      expect(db.delegates.aiConversation.deleteMany).toHaveBeenCalledTimes(1);
      expect(db.delegates.aiConversation.deleteMany).toHaveBeenCalledWith({
        where: { id, userId: ALICE },
      });
      // deleteAgentConversation itself never performs manual message
      // cleanup — cascade reuse, never duplicate logic. (`aiMessage.deleteMany`
      // exists for the Phase 10.28C-prep turn compensation, not for
      // conversation deletion.)
      expect(db.delegates.aiMessage.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 10.26B archive / unarchive
  // ---------------------------------------------------------------------------

  describe("archiveAgentConversation / unarchiveAgentConversation", () => {
    async function seedOwned(title = "Archiv me"): Promise<string> {
      const { id } = await persistAgentTurn({
        userId: ALICE,
        instruction: "List my files.",
        maxToolRounds: 2,
        title,
        rounds: [
          {
            text: "Looking…",
            toolCalls: [{ id: "c1", toolName: "read_file_metadata", input: {} }],
            toolResults: [
              {
                ok: true,
                callId: "c1",
                data: {
                  fileId: "f0000000-0000-0000-0000-0000000000f0",
                  versionId: "v0000000-0000-0000-0000-0000000000v0",
                  name: "bill.pdf",
                },
              },
            ],
          },
        ],
        finalText: "Done.",
      });
      return id;
    }

    it("archives an owned conversation, stamping a new archived_at", async () => {
      const id = await seedOwned();
      const now = new Date(1_705_000_001_000);

      const result = await archiveAgentConversation(ALICE, id, now);

      expect(result).toMatchObject({ id, title: "Archiv me", archivedAt: now });
      const row = db.conversations.find((c) => c.id === id);
      expect(row?.archivedAt).toEqual(now);
      // A single ownership-scoped update — no reads-before-write race.
      expect(db.delegates.aiConversation.updateMany).toHaveBeenCalledTimes(1);
      expect(db.delegates.aiConversation.updateMany).toHaveBeenCalledWith({
        where: { id, userId: ALICE },
        data: { archivedAt: now, updatedAt: expect.any(Date) },
      });
    });

    it("is idempotent: archiving an already archived conversation succeeds", async () => {
      const id = await seedOwned();
      const first = new Date(1_705_000_001_000);
      await archiveAgentConversation(ALICE, id, first);

      const second = new Date(1_705_000_002_000);
      await expect(archiveAgentConversation(ALICE, id, second)).resolves.toMatchObject({
        id,
        archivedAt: second,
      });
    });

    it("hides archived conversations from the list, leaving the row intact", async () => {
      const archivedId = await seedOwned("Old invoices");
      const activeId = await seedOwned("Active notes");
      await archiveAgentConversation(ALICE, archivedId, new Date(1_705_000_001_000));

      const rows = await listAgentConversations(ALICE);

      expect(rows.map((r) => r.id)).toEqual([activeId]);
      expect(db.conversations.find((c) => c.id === archivedId)).toBeDefined();
      // Transcript and refs are untouched by archiving.
      expect(db.messages.filter((m) => m.conversationId === archivedId)).toHaveLength(3);
    });

    it("unarchives a conversation, clearing archived_at back to null", async () => {
      const id = await seedOwned();
      await archiveAgentConversation(ALICE, id, new Date(1_705_000_001_000));

      const result = await unarchiveAgentConversation(ALICE, id, new Date(1_705_000_001_500));

      expect(result).toMatchObject({ id, title: "Archiv me", archivedAt: null });
      expect(db.conversations.find((c) => c.id === id)?.archivedAt).toBeNull();
    });

    it("is idempotent: unarchiving an active conversation succeeds with no-op semantics", async () => {
      const id = await seedOwned();

      await expect(
        unarchiveAgentConversation(ALICE, id, new Date(1_705_000_001_000)),
      ).resolves.toMatchObject({
        id,
        archivedAt: null,
      });
    });

    it("restores an unarchived conversation to the normal list", async () => {
      const archivedId = await seedOwned("Old invoices");
      await archiveAgentConversation(ALICE, archivedId, new Date(1_705_000_001_000));
      expect((await listAgentConversations(ALICE)).map((r) => r.id)).not.toContain(archivedId);

      await unarchiveAgentConversation(ALICE, archivedId, new Date(1_705_000_002_000));

      expect((await listAgentConversations(ALICE)).map((r) => r.id)).toContain(archivedId);
    });

    it("still returns an archived conversation by id to its owner", async () => {
      const id = await seedOwned();
      await archiveAgentConversation(ALICE, id, new Date(1_705_000_001_000));

      const detail = await getAgentConversation(ALICE, id);

      expect(detail).not.toBeNull();
      expect(detail?.conversation.archivedAt).toEqual(new Date(1_705_000_001_000));
      expect(detail?.messages).toHaveLength(3);
    });

    it("enforces ownership: a foreign or missing owner is indistinguishable (404 contract)", async () => {
      const id = await seedOwned();

      const foreign = archiveAgentConversation(BOB, id, new Date(1_705_000_001_000)).catch((e) => e);
      const missing = archiveAgentConversation(
        ALICE,
        "00000000-0000-0000-0000-000000000000",
        new Date(1_705_000_001_000),
      ).catch((e) => e);

      await expect(foreign).resolves.toBeInstanceOf(AgentConversationNotFoundError);
      await expect(missing).resolves.toBeInstanceOf(AgentConversationNotFoundError);
      expect(db.conversations.find((c) => c.id === id)?.archivedAt).toBeNull();
      // Nothing was written for the missing id.
      expect(db.delegates.aiConversation.updateMany).toHaveBeenCalledTimes(2);
      expect(db.delegates.aiConversation.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: "00000000-0000-0000-0000-000000000000", userId: ALICE },
        data: { archivedAt: expect.any(Date), updatedAt: expect.any(Date) },
      });
    });

    it("never touches transcripts, tool data, or file references", async () => {
      const id = await seedOwned();
      const beforeMessages = db.messages.map((m) => ({ ...m }));
      const round = db.messages.find((m) => m.conversationId === id && m.toolResults !== null);
      const beforeToolResults = round?.toolResults;
      db.delegates.$transaction.mockClear();

      await archiveAgentConversation(ALICE, id, new Date(1_705_000_001_000));
      await unarchiveAgentConversation(ALICE, id, new Date(1_705_000_002_000));

      expect(db.messages).toEqual(beforeMessages);
      expect(round?.toolResults).toEqual(beforeToolResults);
      // Only conversation-level writes happened — no message or file delegates.
      expect(db.delegates.$transaction).not.toHaveBeenCalled();
      expect(Object.keys(db.delegates)).toEqual([
        "aiConversation",
        "aiMessage",
        "$transaction",
      ]);
    });
  });

  describe("eager turn persistence — begin/append/complete/cancel (Phase 10.28C-prep)", () => {
    beforeEach(() => {
      db = createFakeDb();
      mocks.getDatabase.mockReturnValue(db.delegates);
    });

    it("beginAgentTurn commits a conversation, instruction, and first round with real ids", async () => {
      const begun = await beginAgentTurn({
        userId: ALICE,
        instruction: "List my docs.",
        maxToolRounds: 2,
        title: "Docs listing",
        toolCalls: [{ id: "c1", toolName: "list_directory", input: { path: "/home" } }],
      });

      expect(begun.created).toBe(true);
      expect(begun.conversationId).toBe("conv-1");
      expect(begun.instructionMessageId).toBe("msg-1");
      expect(begun.messageId).toBe("msg-2");
      // The ids are REAL committed rows, immediately readable.
      const loaded = await loadAgentConversationState(ALICE, begun.conversationId);
      expect(loaded).not.toBeNull();
      if (loaded === null) return;
      expect(loaded.instruction).toBe("List my docs.");
      expect(loaded.maxToolRounds).toBe(2);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]).toMatchObject({ kind: "provider", toolCalls: [{ id: "c1" }] });
    });

    it("resumes an owned conversation without creating a new one", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "First turn",
        maxToolRounds: 2,
      });
      const before = db.messages.length;

      const begun = await beginAgentTurn({
        userId: ALICE,
        conversationId: created.id,
        instruction: "Second turn",
        maxToolRounds: 2,
        toolCalls: [{ id: "c1", toolName: "search_files", input: { query: "x" } }],
      });

      expect(begun.created).toBe(false);
      expect(begun.conversationId).toBe(created.id);
      // Only the instruction + first round rows were appended.
      expect(db.messages).toHaveLength(before + 2);
      expect(db.conversations).toHaveLength(1);
    });

    it("rejects a foreign conversation for begin and writes nothing", async () => {
      const beforeMessages = db.messages.length;
      await expect(
        beginAgentTurn({
          userId: ALICE,
          conversationId: "conv-foreign",
          instruction: "sneak",
          maxToolRounds: 1,
          toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }],
        }),
      ).rejects.toThrow(AgentConversationNotFoundError);
      expect(db.messages).toHaveLength(beforeMessages);
      expect(db.conversations).toHaveLength(0);
    });

    it("appendAgentTurnRoundMessage commits a later round message", async () => {
      const begun = await beginAgentTurn({
        userId: ALICE,
        instruction: "Go",
        maxToolRounds: 2,
        toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }],
      });
      const appended = await appendAgentTurnRoundMessage({
        userId: ALICE,
        conversationId: begun.conversationId,
        text: "second round",
        toolCalls: [{ id: "c2", toolName: "search_files", input: { query: "y" } }],
      });

      expect(appended.messageId).toBeDefined();
      const round = db.messages.find((m) => m.id === appended.messageId);
      expect(round).toMatchObject({
        conversationId: begun.conversationId,
        role: "assistant",
        content: "second round",
      });
      expect(round?.toolCalls).toEqual([
        { id: "c2", toolName: "search_files", input: { query: "y" } },
      ]);
    });

    it("appendAgentTurnRoundMessage enforces ownership before writing", async () => {
      await expect(
        appendAgentTurnRoundMessage({
          userId: ALICE,
          conversationId: "conv-foreign",
          toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }],
        }),
      ).rejects.toThrow(AgentConversationNotFoundError);
    });

    it("completeAgentTurn attaches each round's results and appends the final reply atomically", async () => {
      const begun = await beginAgentTurn({
        userId: ALICE,
        instruction: "Go",
        maxToolRounds: 2,
        toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }],
      });
      const appended = await appendAgentTurnRoundMessage({
        userId: ALICE,
        conversationId: begun.conversationId,
        toolCalls: [{ id: "c2", toolName: "search_files", input: { query: "y" } }],
      });

      const updatedBefore = db.conversations[0]?.updatedAt as Date;
      await completeAgentTurn({
        userId: ALICE,
        conversationId: begun.conversationId,
        rounds: [
          {
            messageId: begun.messageId,
            toolResults: [{ ok: true, callId: "c1", data: { items: [] } }],
          },
          { messageId: appended.messageId, toolResults: [{ ok: true, callId: "c2", data: [] }] },
        ],
        finalText: "Done.",
      });

      const rows = db.messages;
      expect(rows).toHaveLength(4);
      // Round results land on the EXACT eager messages.
      expect(rows.find((m) => m.id === begun.messageId)?.toolResults).toEqual([
        { ok: true, callId: "c1", data: { items: [] } },
      ]);
      expect(rows.find((m) => m.id === appended.messageId)?.toolResults).toEqual([
        { ok: true, callId: "c2", data: [] },
      ]);
      expect(rows.at(-1)).toMatchObject({ role: "assistant", content: "Done.", isFinal: true });
      // updated_at was bumped.
      expect(db.conversations[0]?.updatedAt).not.toEqual(updatedBefore);
    });

    it("completeAgentTurn rejects a foreign conversation and writes nothing", async () => {
      await expect(
        completeAgentTurn({
          userId: ALICE,
          conversationId: "conv-foreign",
          rounds: [],
          finalText: "Done.",
        }),
      ).rejects.toThrow(AgentConversationNotFoundError);
      expect(db.messages).toHaveLength(0);
    });

    it("completeAgentTurn rolls back when a round message vanished", async () => {
      const begun = await beginAgentTurn({
        userId: ALICE,
        instruction: "Go",
        maxToolRounds: 2,
        toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }],
      });

      await expect(
        completeAgentTurn({
          userId: ALICE,
          conversationId: begun.conversationId,
          rounds: [
            { messageId: "msg-ghost", toolResults: [{ ok: true, callId: "c1", data: null }] },
          ],
          finalText: "Done.",
        }),
      ).rejects.toThrow(AgentConversationNotFoundError);

      // Nothing from the completion write landed (no final row, no results).
      const rows = db.messages;
      expect(rows).toHaveLength(2);
      expect(rows.every((m) => !m.isFinal)).toBe(true);
      expect(rows.every((m) => m.toolResults === null || m.toolResults === undefined)).toBe(true);
    });

    it("cancelAgentTurn deletes a turn-created conversation (cascade removes its rows)", async () => {
      const begun = await beginAgentTurn({
        userId: ALICE,
        instruction: "Go",
        maxToolRounds: 2,
        toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }],
      });

      await cancelAgentTurn({
        userId: ALICE,
        conversationId: begun.conversationId,
        created: true,
        messageIds: [begun.instructionMessageId, begun.messageId],
      });

      // The whole partial turn is gone — nothing invalid remains.
      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it("cancelAgentTurn on a resumed turn removes ONLY this turn's messages", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "First turn",
        maxToolRounds: 2,
      });
      const priorMessages = db.messages.map((m) => ({ id: m.id }));

      const begun = await beginAgentTurn({
        userId: ALICE,
        conversationId: created.id,
        instruction: "Second turn",
        maxToolRounds: 2,
        toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }],
      });
      expect(db.messages.length).toBe(priorMessages.length + 2);

      await cancelAgentTurn({
        userId: ALICE,
        conversationId: created.id,
        created: false,
        messageIds: [begun.instructionMessageId, begun.messageId],
      });

      // The conversation and its PRIOR transcript survive untouched; only the
      // failed turn's own rows are removed.
      expect(db.conversations).toHaveLength(1);
      expect(db.messages.map((m) => m.id)).toEqual(priorMessages.map((m) => m.id));
    });

    it("cancelAgentTurn is a safe no-op for a foreign conversation", async () => {
      await expect(
        cancelAgentTurn({
          userId: ALICE,
          conversationId: "conv-foreign",
          created: true,
          messageIds: ["msg-1"],
        }),
      ).resolves.toBeUndefined();
    });

    it("an interrupted turn (begin+append, no complete) still loads as a valid transcript", async () => {
      // The crash window: eager rows committed but the turn never completed.
      const begun = await beginAgentTurn({
        userId: ALICE,
        instruction: "Interrupted turn",
        maxToolRounds: 2,
        toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }],
      });
      await appendAgentTurnRoundMessage({
        userId: ALICE,
        conversationId: begun.conversationId,
        toolCalls: [{ id: "c2", toolName: "search_files", input: { query: "y" } }],
      });

      const loaded = await loadAgentConversationState(ALICE, begun.conversationId);
      expect(loaded).not.toBeNull();
      if (loaded === null) return;
      // Valid-but-incomplete: instruction + two provider rounds, no final,
      // toolRounds not advanced. Never corrupt.
      expect(loaded.instruction).toBe("Interrupted turn");
      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages.every((m) => m.kind === "provider")).toBe(true);
      expect(loaded.finalText).toBeUndefined();
      expect(loaded.toolRounds).toBe(0);
    });
  });

  describe("listConversationLastMessages (Phase 10.31)", () => {
    it("returns each OWNED conversation's LAST transcript row", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "Summarize.",
        maxToolRounds: 3,
      });
      await appendAgentTurn(ALICE, created.id, { text: "Working…" });
      await appendAgentFinal(ALICE, created.id, "Done.");
      // Bob's conversation is foreign to Alice and must be excluded even
      // though its id is in the requested list.
      const foreign = await createAgentConversation({
        userId: BOB,
        instruction: "Yo",
        maxToolRounds: 3,
      });
      await appendAgentTurn(BOB, foreign.id, { text: "hey" });

      const rows = await listConversationLastMessages(ALICE, [created.id, foreign.id]);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        conversationId: created.id,
        role: "assistant",
        isFinal: true,
        messageId: expect.any(String),
      });
    });

    it("returns rows only for the conversation's real owner", async () => {
      const created = await createAgentConversation({
        userId: BOB,
        instruction: "Yo",
        maxToolRounds: 3,
      });
      await appendAgentFinal(BOB, created.id, "Later.");

      // Alice does not own the conversation → indistinguishable from absent.
      expect(await listConversationLastMessages(ALICE, [created.id])).toEqual([]);
      const owned = await listConversationLastMessages(BOB, [created.id]);
      expect(owned).toHaveLength(1);
      expect(owned[0]).toMatchObject({ conversationId: created.id, isFinal: true });
    });

    it("returns [] for an empty conversation list without touching the database", async () => {
      await expect(listConversationLastMessages(ALICE, [])).resolves.toEqual([]);
      expect(mocks.getDatabase).not.toHaveBeenCalled();
    });
  });
});