/**
 * AI conversation history service tests (Phase 10.23).
 *
 * The repository is mocked; the mapping/sanitization layer is REAL. Covers:
 *
 *   1. listAiConversations — summary shape, newest-first passthrough, empty.
 *   2. getAiConversation — detail + chronological transcript, foreign/missing
 *      → the SAME 404 `common/not-found`, malformed id → 400 before any query.
 *   3. Safe structured projection — tool-call intents and tool-result metadata
 *      returned in their structured safe form.
 *   4. Raw file contents are never exposed, even when a stored result carries
 *      a base64 `read_file` payload.
 *   5. `fileId` / `versionId` references are returned as references only.
 *   6. Failed results expose only structured code/category (no message).
 *   7. Nothing leaks: no provider keys, credential handles, env-shaped
 *      strings, filesystem paths beyond conversation references, provider
 *      internals, stack traces, or DB internals in serialized output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../core/errors.js";
import {
  archiveAiConversation,
  deleteAiConversation,
  deriveConversationTurnState,
  getAiConversation,
  listAiConversations,
  renameAiConversation,
  projectStructuredValue,
  unarchiveAiConversation,
  type AiConversationArchiveResult,
  type AiConversationDetail,
  type AiConversationDeletionResult,
  type AiConversationRenameResult,
  type AiConversationSummary,
  type AiTurnState,
} from "./aiConversations.js";
import { AgentConversationNotFoundError } from "../database/repositories/agentConversations.js";
import type { AiToolApproval } from "./aiToolApprovals.js";

const mocks = vi.hoisted(() => ({
  listAgentConversations: vi.fn(),
  getAgentConversation: vi.fn(),
  deleteAgentConversation: vi.fn(),
  renameAgentConversation: vi.fn(),
  archiveAgentConversation: vi.fn(),
  unarchiveAgentConversation: vi.fn(),
  listConversationLastMessages: vi.fn(),
  listConversationToolApprovals: vi.fn(),
}));

vi.mock("../database/repositories/agentConversations.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../database/repositories/agentConversations.js")>();
  return {
    ...actual,
    listAgentConversations: mocks.listAgentConversations,
    getAgentConversation: mocks.getAgentConversation,
    deleteAgentConversation: mocks.deleteAgentConversation,
    renameAgentConversation: mocks.renameAgentConversation,
    archiveAgentConversation: mocks.archiveAgentConversation,
    unarchiveAgentConversation: mocks.unarchiveAgentConversation,
    listConversationLastMessages: mocks.listConversationLastMessages,
  };
});

vi.mock("./aiToolApprovals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aiToolApprovals.js")>();
  return {
    ...actual,
    // The REAL status constants and safe projection stay in the pipeline; only
    // the ownership-scoped read is stubbed so the tests stay database-free.
    listConversationToolApprovals: mocks.listConversationToolApprovals,
  };
});

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const BASE_CONVERSATION = {
  id: CONVERSATION_ID,
  userId: ALICE,
  title: "Invoice review",
  maxToolRounds: 3,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-03T00:00:00Z"),
};

function storedMessage(overrides?: object): { id: string; role: string; content: string; createdAt: Date; isFinal: boolean; toolCalls?: unknown; toolResults?: unknown } {
  return {
    id: "msg-1",
    role: "user",
    content: "List my files.",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    isFinal: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Turn-state enrichment defaults: no approvals, no last messages. Tests that
  // care about a specific state override these, exactly like the repository.
  mocks.listConversationToolApprovals.mockResolvedValue([]);
  mocks.listConversationLastMessages.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// 1. List
// ---------------------------------------------------------------------------

describe("listAiConversations", () => {
  it("returns safe summaries in the repository's newest-first order", async () => {
    mocks.listAgentConversations.mockResolvedValue([
      {
        ...BASE_CONVERSATION,
        id: "first-conv",
        updatedAt: new Date("2026-01-03T00:00:00Z"),
        privateKey: "sk-nope",
      },
      {
        ...BASE_CONVERSATION,
        id: "second-conv",
        title: null,
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    ] as unknown as Awaited<ReturnType<typeof mocks.listAgentConversations>>);
    // The first conversation ended with an assistant final reply.
    mocks.listConversationLastMessages.mockResolvedValue([
      { conversationId: "first-conv", messageId: "final-1", role: "assistant", isFinal: true },
    ]);

    const rows: AiConversationSummary[] = await listAiConversations(ALICE);

    expect(mocks.listAgentConversations).toHaveBeenCalledWith(ALICE);
    expect(rows.map((r) => r.id)).toEqual(["first-conv", "second-conv"]);
    expect(rows[0]).toEqual({
      id: "first-conv",
      title: "Invoice review",
      maxToolRounds: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      turnState: "completed",
      pendingApprovals: [],
    });
    expect(rows[1]?.title).toBeNull();
    // The summary is an explicit projection — arbitrary repo columns never
    // reach the response.
    expect(JSON.stringify(rows)).not.toContain("sk-nope");
    expect(JSON.stringify(rows)).not.toContain("userId");
    // Turn-state enrichment is batched over the listed ids only.
    expect(mocks.listConversationToolApprovals).toHaveBeenCalledWith(ALICE, [
      "first-conv",
      "second-conv",
    ]);
    expect(mocks.listConversationLastMessages).toHaveBeenCalledWith(ALICE, [
      "first-conv",
      "second-conv",
    ]);
  });

  it("returns a valid empty array for empty history", async () => {
    mocks.listAgentConversations.mockResolvedValue([]);

    expect(await listAiConversations(ALICE)).toEqual([]);
  });

  describe("— title search (Phase 10.27)", () => {
    it("forwards a trimmed non-empty query to the repository", async () => {
      mocks.listAgentConversations.mockResolvedValue([]);

      await listAiConversations(ALICE, "  Invoice Review  ");

      expect(mocks.listAgentConversations).toHaveBeenCalledTimes(1);
      expect(mocks.listAgentConversations).toHaveBeenCalledWith(ALICE, "Invoice Review");
    });

    it("treats an empty/whitespace-only query exactly like no query", async () => {
      mocks.listAgentConversations.mockResolvedValue([]);

      await listAiConversations(ALICE, "");
      await listAiConversations(ALICE, "   ");
      await listAiConversations(ALICE, "\t\n ");

      // No search filter is forwarded — the no-query path is identical.
      expect(mocks.listAgentConversations).toHaveBeenCalledTimes(3);
      expect(mocks.listAgentConversations).toHaveBeenLastCalledWith(ALICE);
    });

    it("rejects a non-string query with 400 before any repository call", async () => {
      for (const bad of [42, true, null, {}, []]) {
        await expect(listAiConversations(ALICE, bad as unknown as string)).rejects.toMatchObject({
          status: 400,
          code: "common/bad-request",
        });
      }
      expect(mocks.listAgentConversations).not.toHaveBeenCalled();
    });

    it("rejects a query exceeding 255 characters after trimming, 255 is valid", async () => {
      await expect(
        listAiConversations(ALICE, "".padStart(256, "x")),
      ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });
      expect(mocks.listAgentConversations).not.toHaveBeenCalled();

      mocks.listAgentConversations.mockResolvedValue([]);
      const max = "x".repeat(255);
      await listAiConversations(ALICE, max);
      expect(mocks.listAgentConversations).toHaveBeenCalledWith(ALICE, max);
    });

    it("maps only the filtered results to safe summary shapes", async () => {
      mocks.listAgentConversations.mockResolvedValue([
        {
          ...BASE_CONVERSATION,
          title: "Invoice review",
          updatedAt: new Date("2026-01-03T00:00:00Z"),
        },
      ] as unknown as Awaited<ReturnType<typeof mocks.listAgentConversations>>);
      mocks.listConversationLastMessages.mockResolvedValue([
        { conversationId: CONVERSATION_ID, messageId: "final-1", role: "assistant", isFinal: true },
      ]);

      const rows = await listAiConversations(ALICE, "invoice");

      expect(rows).toEqual([
        {
          id: CONVERSATION_ID,
          title: "Invoice review",
          maxToolRounds: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
          turnState: "completed",
          pendingApprovals: [],
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain("userId");
      expect(JSON.stringify(rows)).not.toContain("archivedAt");
    });

    it("performs no provider, network, or filesystem calls while searching", async () => {
      mocks.listAgentConversations.mockResolvedValue([]);
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await listAiConversations(ALICE, "invoice");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
    });
  });
});

// ---------------------------------------------------------------------------
// 2 & 6. Single retrieval + 404 / validation
// ---------------------------------------------------------------------------

describe("getAiConversation", () => {
  it("returns the conversation with its chronological transcript", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage({ createdAt: new Date("2026-01-01T00:00:01Z") }),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Done.",
          isFinal: true,
          createdAt: new Date("2026-01-01T00:00:02Z"),
        }),
      ],
    });

    const detail: AiConversationDetail = await getAiConversation(ALICE, CONVERSATION_ID);

    expect(mocks.getAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID);
    expect(detail.id).toBe(CONVERSATION_ID);
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages.map((m) => m.createdAt)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
    ]);
  });

  it("maps a foreign AND a missing conversation to the same 404 not-found", async () => {
    mocks.getAgentConversation.mockResolvedValue(null);
    mocks.getAgentConversation.mockResolvedValueOnce(null);

    const foreign = await getAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);
    const missing = await getAiConversation(ALICE, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee").catch((e) => e);

    expect(foreign).toBeInstanceOf(AppError);
    expect(foreign).toMatchObject({ status: 404, code: "common/not-found" });
    expect(missing).toMatchObject({ status: 404, code: "common/not-found" });
    expect(foreign).toEqual(missing);
  });

  it("rejects a malformed conversationId with 400 before any repository call", async () => {
    for (const bad of ["", "not-a-uuid", "../etc/passwd", "GGGGGGGG-…", "azure"]) {
      await expect(getAiConversation(ALICE, bad)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.getAgentConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3, 4, 5, 6, 7. Safe structured projection + leak tests
// ---------------------------------------------------------------------------

describe("getAiConversation — safe structured projection", () => {
  it("returns tool intents and result metadata in their structured safe form", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Listing…",
          isFinal: false,
          toolCalls: [
            { id: "c1", toolName: "list_directory", input: { path: "/home/me" } },
          ],
          toolResults: [
            {
              ok: true,
              callId: "c1",
              data: {
                path: "/home/me",
                isHome: true,
                itemCount: 2,
                items: [{ name: "bills.pdf", sizeBytes: 1024 }],
              },
            },
          ],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);

    const round = detail.messages[1];
    expect(round?.toolCalls).toEqual([
      { callId: "c1", toolName: "list_directory", input: { path: "/home/me" } },
    ]);
    expect(round?.toolResults).toEqual([
      {
        ok: true,
        callId: "c1",
        data: {
          path: "/home/me",
          isHome: true,
          itemCount: 2,
          items: [{ name: "bills.pdf", sizeBytes: 1024 }],
        },
      },
    ]);
  });

  it("never exposes raw file contents, even when a stored result carries a base64 payload", async () => {
    const rawContent = "TOP-SECRET FILE BODY";
    const base64Body = Buffer.from(rawContent).toString("base64");
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Reading…",
          toolCalls: [{ id: "r1", toolName: "read_file", input: { path: "/home/me/secret.txt" } }],
          toolResults: [{ ok: true, callId: "r1", data: { encoding: "base64", data: base64Body } }],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(detail);

    expect(serialized).not.toContain(base64Body);
    expect(serialized).not.toContain(rawContent);
    expect(serialized).not.toContain("TOP-SECRET");
    expect(serialized).not.toContain('"data"');
    expect(serialized).not.toContain('"encoding"');
  });

  it("keeps structured fileId/versionId references as references only (never contents)", async () => {
    const fileId = "f0000000-0000-0000-0000-0000000000f0";
    const versionId = "v0000000-0000-0000-0000-0000000000v0";
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Analyzed.",
          toolCalls: [{ id: "a1", toolName: "read_file_metadata", input: { fileId, versionId } }],
          toolResults: [{ ok: true, callId: "a1", data: { fileId, versionId, name: "bill.pdf" } }],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(detail);

    expect(serialized).toContain(fileId);
    expect(serialized).toContain(versionId);
    expect(serialized).toContain('"name":"bill.pdf"');
    // The ids are opaque REFERENCES in structured metadata — never expanded
    // into file rows or content. Only the transcript's own text is present.
    expect(serialized).not.toContain('"fileId":"' + fileId + '"' + '"contents"');
    expect(serialized).not.toContain("bill.pdf contents");
  });

  it("reduces failed tool results to structured code/category and drops the message", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Denied.",
          toolCalls: [{ id: "f1", toolName: "read_file", input: {} }],
          toolResults: [
            {
              ok: false,
              callId: "f1",
              error: {
                code: "filesystem/read-unauthorized",
                category: "authorization",
                message: "unable to read /Users/me/: permission denied (internal)",
              },
            },
          ],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(detail);

    expect(detail.messages[1]?.toolResults).toEqual([
      {
        ok: false,
        callId: "f1",
        error: { code: "filesystem/read-unauthorized", category: "authorization" },
      },
    ]);
    expect(serialized).not.toContain("permission denied");
    expect(serialized).not.toContain("/Users/me");
  });

  it("guarantees no provider keys, credential handles, env, internals, or stack traces leak", async () => {
    const fakeKey = "sk-LIVE-AAAAAAAA";
    const fakeHandle = "credential-1";
    const fakeEnv = "GROK_API_KEY";
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Reading…",
          toolCalls: [{ id: "x1", toolName: "read_file", input: {} }],
          toolResults: [
            {
              ok: true,
              callId: "x1",
              data: {
                providerConfig: { apiKey: fakeKey, handle: fakeHandle },
                traced: "Error: at getAgentConversation (internal.ts:42)",
                envFile: { [fakeEnv]: "nope" },
              },
            },
          ],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(detail);

    expect(serialized).not.toContain(fakeKey);
    expect(serialized).not.toContain(fakeHandle);
    expect(serialized).not.toContain(fakeEnv);
    expect(serialized).not.toContain("internal.ts");
    expect(serialized).not.toContain("Error: at ");
  });

  it("projectStructuredValue strips content-bearing fields recursively at any depth", () => {
    expect(projectStructuredValue({ data: "x", encoding: "base64", keep: 1 })).toEqual({
      keep: 1,
    });
    expect(
      projectStructuredValue({ nested: { deep: { content: "y", text: "z", lines: ["a"] } } }),
    ).toEqual({ nested: { deep: {} } });
    expect(projectStructuredValue([{ raw: "x" }, "plain"])).toEqual([{}, "plain"]);
    expect(projectStructuredValue({ fileId: "f-1", name: "a.pdf", meta: "b" })).toEqual({
      fileId: "f-1",
      name: "a.pdf",
      meta: "b",
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 10.24 delete
// ---------------------------------------------------------------------------

describe("deleteAiConversation", () => {
  it("deletes an owned conversation and returns the small stable success result", async () => {
    mocks.deleteAgentConversation.mockResolvedValue(undefined);

    const result: AiConversationDeletionResult = await deleteAiConversation(
      ALICE,
      CONVERSATION_ID,
    );

    expect(mocks.deleteAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID);
    expect(result).toEqual({ conversationId: CONVERSATION_ID, deleted: true });
    // The stable result carries only confirmation — never deleted contents.
    expect(Object.keys(result).sort()).toEqual(["conversationId", "deleted"]);
  });

  it("rejects a malformed conversationId with 400 before touching the repository", async () => {
    for (const bad of ["", "not-a-uuid", "../etc/passwd", "GGGG"]) {
      await expect(deleteAiConversation(ALICE, bad)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.deleteAgentConversation).not.toHaveBeenCalled();
  });

  it("maps a foreign AND a missing conversation to the same 404 (indistinguishable)", async () => {
    mocks.deleteAgentConversation.mockImplementation(() => {
      throw new AgentConversationNotFoundError();
    });

    const foreign = await deleteAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);
    const missing = await deleteAiConversation(
      ALICE,
      "ddd11111-1111-1111-1111-111111111111",
    ).catch((e) => e);

    expect(foreign).toBeInstanceOf(AppError);
    expect(foreign).toMatchObject({ status: 404, code: "common/not-found" });
    expect(missing).toEqual(foreign);
  });

  it("treats a repeated deletion of an already-deleted conversation as 404", async () => {
    mocks.deleteAgentConversation
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AgentConversationNotFoundError());

    await expect(deleteAiConversation(ALICE, CONVERSATION_ID)).resolves.toMatchObject({
      deleted: true,
    });
    await expect(deleteAiConversation(ALICE, CONVERSATION_ID)).rejects.toMatchObject({
      status: 404,
      code: "common/not-found",
    });
  });

  it("propagates unexpected repository failures raw for the generic internal-error envelope", async () => {
    const raw = new Error("SECRET SQL: SELECT * FROM internal.creds at db.ts:9");
    mocks.deleteAgentConversation.mockRejectedValueOnce(raw);

    const outcome = await deleteAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);

    expect(outcome).toBe(raw);
    expect(outcome).not.toBeInstanceOf(AppError);
  });

  it("never treats stored fileId/versionId references as deletion targets", async () => {
    mocks.deleteAgentConversation.mockResolvedValue(undefined);

    await deleteAiConversation(ALICE, CONVERSATION_ID);

    // The service/repository scope never receives file or version ids — only
    // the conversation id. Anything beyond that is the repository's domain.
    expect(mocks.deleteAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID);
    expect(mocks.deleteAgentConversation).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 10.25 rename
// ---------------------------------------------------------------------------

describe("renameAiConversation", () => {
  it("renames an owned conversation and returns the stable title result", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "New title",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const result: AiConversationRenameResult = await renameAiConversation(
      ALICE,
      CONVERSATION_ID,
      "New title",
    );

    expect(mocks.renameAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID, "New title");
    expect(result).toEqual({ conversationId: CONVERSATION_ID, title: "New title" });
    // The stable result is an explicit projection — no updatedAt, userId,
    // or other repository columns leak.
    expect(Object.keys(result).sort()).toEqual(["conversationId", "title"]);
  });

  it("trims leading and trailing whitespace from the title", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Trimmed",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const result = await renameAiConversation(ALICE, CONVERSATION_ID, "  Trimmed  ");

    expect(mocks.renameAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID, "Trimmed");
    expect(result.title).toBe("Trimmed");
  });

  it("passes the 255-character trimmed title to the repository", async () => {
    const maxTitle = "a".repeat(255);
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: maxTitle,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const result = await renameAiConversation(ALICE, CONVERSATION_ID, maxTitle);

    expect(mocks.renameAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID, maxTitle);
    expect(result.title).toBe(maxTitle);
  });

  it("rejects a non-string title with 400 common/bad-request", async () => {
    for (const bad of [42, true, null, undefined, {}, []]) {
      await expect(renameAiConversation(ALICE, CONVERSATION_ID, bad as unknown as string)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.renameAgentConversation).not.toHaveBeenCalled();
  });

  it("rejects an empty or whitespace-only title with 400 common/bad-request", async () => {
    for (const bad of ["", "   ", "\t\n"]) {
      await expect(renameAiConversation(ALICE, CONVERSATION_ID, bad)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.renameAgentConversation).not.toHaveBeenCalled();
  });

  it("rejects a title exceeding 255 characters after trimming with 400", async () => {
    await expect(
      renameAiConversation(ALICE, CONVERSATION_ID, "x".repeat(256)),
    ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });
    // Exactly 255 after trim is valid
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "x".repeat(255),
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    await expect(
      renameAiConversation(ALICE, CONVERSATION_ID, "x".repeat(255)),
    ).resolves.toMatchObject({ title: "x".repeat(255) });
    expect(mocks.renameAgentConversation).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed conversationId with 400 before any repository call", async () => {
    for (const bad of ["", "not-a-uuid", "../etc/passwd", "GGGG"]) {
      await expect(renameAiConversation(ALICE, bad, "ok")).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.renameAgentConversation).not.toHaveBeenCalled();
  });

  it("maps a foreign AND a missing conversation to the same 404 not-found", async () => {
    mocks.renameAgentConversation.mockImplementation(() => {
      throw new AgentConversationNotFoundError();
    });

    const foreign = await renameAiConversation(ALICE, CONVERSATION_ID, "New").catch((e) => e);
    const missing = await renameAiConversation(
      ALICE,
      "ddd11111-1111-1111-1111-111111111111",
      "New",
    ).catch((e) => e);

    expect(foreign).toBeInstanceOf(AppError);
    expect(foreign).toMatchObject({ status: 404, code: "common/not-found" });
    expect(missing).toMatchObject({ status: 404, code: "common/not-found" });
    expect(foreign).toEqual(missing);
  });

  it("propagates unexpected repository failures raw for the generic internal-error envelope", async () => {
    const raw = new Error("SECRET SQL: SELECT * FROM internal.creds at db.ts:9");
    mocks.renameAgentConversation.mockRejectedValueOnce(raw);

    const outcome = await renameAiConversation(ALICE, CONVERSATION_ID, "New").catch((e) => e);

    expect(outcome).toBe(raw);
    expect(outcome).not.toBeInstanceOf(AppError);
  });

  it("returns ONLY the conversationId and title — no updatedAt, no userId, no extra fields", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Updated",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const result = await renameAiConversation(ALICE, CONVERSATION_ID, "Updated");

    expect(Object.keys(result)).toEqual(["conversationId", "title"]);
    expect(JSON.stringify(result)).not.toContain(ALICE);
    expect(JSON.stringify(result)).not.toContain("updatedAt");
  });

  it("confirms the same title can be written twice (idempotent)", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Stable",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const first = await renameAiConversation(ALICE, CONVERSATION_ID, "Stable");
    const second = await renameAiConversation(ALICE, CONVERSATION_ID, "Stable");

    expect(first).toEqual(second);
    expect(mocks.renameAgentConversation).toHaveBeenCalledTimes(2);
  });

  it("confirms no provider/network/filesystem operations occur", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Safe",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await renameAiConversation(ALICE, CONVERSATION_ID, "Safe");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Phase 10.26B archive / unarchive
// ---------------------------------------------------------------------------

describe("archiveAiConversation", () => {
  it("archives an owned conversation and returns the stable safe metadata", async () => {
    const archivedAt = new Date("2026-01-04T00:00:00Z");
    mocks.archiveAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Invoice review",
      archivedAt,
    });

    const result: AiConversationArchiveResult = await archiveAiConversation(
      ALICE,
      CONVERSATION_ID,
    );

    expect(mocks.archiveAgentConversation).toHaveBeenCalledWith(
      ALICE,
      CONVERSATION_ID,
      expect.any(Date),
    );
    expect(result).toEqual({
      conversationId: CONVERSATION_ID,
      title: "Invoice review",
      archivedAt: "2026-01-04T00:00:00.000Z",
    });
    // The stable result is an explicit projection — no userId, no contents.
    expect(Object.keys(result).sort()).toEqual(["archivedAt", "conversationId", "title"]);
  });

  it("maps a foreign AND a missing conversation to the same 404 not-found", async () => {
    mocks.archiveAgentConversation.mockImplementation(() => {
      throw new AgentConversationNotFoundError();
    });

    const foreign = await archiveAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);
    const missing = await archiveAiConversation(
      ALICE,
      "ddd11111-1111-1111-1111-111111111111",
    ).catch((e) => e);

    expect(foreign).toBeInstanceOf(AppError);
    expect(foreign).toMatchObject({ status: 404, code: "common/not-found" });
    expect(missing).toMatchObject({ status: 404, code: "common/not-found" });
    expect(foreign).toEqual(missing);
  });

  it("rejects a malformed conversationId with 400 before any repository call", async () => {
    for (const bad of ["", "not-a-uuid", "../etc/passwd", "GGGG"]) {
      await expect(archiveAiConversation(ALICE, bad)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.archiveAgentConversation).not.toHaveBeenCalled();
  });

  it("propagates unexpected repository failures raw for the generic internal-error envelope", async () => {
    const raw = new Error("SECRET SQL: SELECT * FROM internal.creds at db.ts:9");
    mocks.archiveAgentConversation.mockRejectedValueOnce(raw);

    const outcome = await archiveAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);

    expect(outcome).toBe(raw);
    expect(outcome).not.toBeInstanceOf(AppError);
  });

  it("confirms no provider/network/filesystem operations occur", async () => {
    mocks.archiveAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Invoice review",
      archivedAt: new Date(),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await archiveAiConversation(ALICE, CONVERSATION_ID);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it("returns only safe metadata — no userId, message, or provider internals", async () => {
    mocks.archiveAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Invoice review",
      archivedAt: new Date("2026-01-04T00:00:00Z"),
    });

    const result = await archiveAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(ALICE);
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("credential");
  });
});

describe("unarchiveAiConversation", () => {
  it("unarchives an owned conversation and returns archivedAt null", async () => {
    mocks.unarchiveAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Invoice review",
      archivedAt: null,
    });

    const result = await unarchiveAiConversation(ALICE, CONVERSATION_ID);

    expect(mocks.unarchiveAgentConversation).toHaveBeenCalledWith(
      ALICE,
      CONVERSATION_ID,
      expect.any(Date),
    );
    expect(result).toEqual({
      conversationId: CONVERSATION_ID,
      title: "Invoice review",
      archivedAt: null,
    });
  });

  it("maps a foreign AND a missing conversation to the same 404 not-found", async () => {
    mocks.unarchiveAgentConversation.mockImplementation(() => {
      throw new AgentConversationNotFoundError();
    });

    const foreign = await unarchiveAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);
    const missing = await unarchiveAiConversation(
      ALICE,
      "ddd11111-1111-1111-1111-111111111111",
    ).catch((e) => e);

    expect(foreign).toBeInstanceOf(AppError);
    expect(foreign).toMatchObject({ status: 404, code: "common/not-found" });
    expect(missing).toMatchObject({ status: 404, code: "common/not-found" });
    expect(foreign).toEqual(missing);
  });

  it("rejects a malformed conversationId with 400 before any repository call", async () => {
    for (const bad of ["", "not-a-uuid", "../etc/passwd", "GGGG"]) {
      await expect(unarchiveAiConversation(ALICE, bad)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.unarchiveAgentConversation).not.toHaveBeenCalled();
  });

  it("propagates unexpected repository failures raw for the generic internal-error envelope", async () => {
    const raw = new Error("SECRET SQL: SELECT * FROM internal.creds at db.ts:9");
    mocks.unarchiveAgentConversation.mockRejectedValueOnce(raw);

    const outcome = await unarchiveAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);

    expect(outcome).toBe(raw);
    expect(outcome).not.toBeInstanceOf(AppError);
  });

  it("confirms no provider/network/filesystem operations occur", async () => {
    mocks.unarchiveAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Invoice review",
      archivedAt: null,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await unarchiveAiConversation(ALICE, CONVERSATION_ID);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Phase 10.31 — turn-state derivation and enrichment
// ---------------------------------------------------------------------------

describe("deriveConversationTurnState (Phase 10.31)", () => {
  const NOW = new Date("2026-09-09T12:00:00Z");

  function approval(status: string, overrides: Partial<AiToolApproval> = {}): AiToolApproval {
    return {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      conversationId: CONVERSATION_ID,
      messageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      toolName: "delete_file",
      arguments: { path: "/reports/old.txt", permanent: true },
      status,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T11:00:00.000Z",
      expiresAt: "2026-09-09T13:00:00.000Z",
      decidedAt: status === "pending" ? null : "2026-09-09T11:05:00.000Z",
      ...overrides,
    };
  }

  function expectState(
    isFinalReply: boolean,
    approvals: readonly AiToolApproval[],
    expected: AiTurnState,
  ): void {
    expect(deriveConversationTurnState(isFinalReply, approvals, NOW)).toBe(expected);
  }

  it("completed — a final reply with no approvals", () => {
    expectState(true, [], "completed");
  });

  it("failed — no final reply and no approvals", () => {
    expectState(false, [], "failed");
  });

  it("awaiting-approval — an unexpired pending approval wins even with a final reply", () => {
    expectState(true, [approval("pending")], "awaiting-approval");
  });

  it("approved — the most recent approval was approved and nothing is pending", () => {
    expectState(true, [approval("approved")], "approved");
  });

  it("rejected — the most recent approval was rejected", () => {
    expectState(false, [approval("rejected")], "rejected");
  });

  it("expired — the only approval is a pending row whose window elapsed", () => {
    expectState(true, [approval("pending", { expiresAt: "2026-09-09T11:30:00.000Z" })], "expired");
  });

  it("recency — updatedAt decides among resolved states", () => {
    expectState(false, [
      approval("rejected", { id: "older", updatedAt: "2026-09-09T10:30:00.000Z" }),
      approval("approved", { id: "newer", updatedAt: "2026-09-09T11:00:00.000Z" }),
    ], "approved");
    expectState(false, [
      approval("approved", { id: "older2", updatedAt: "2026-09-09T10:30:00.000Z" }),
      approval("rejected", { id: "newer2", updatedAt: "2026-09-09T11:00:00.000Z" }),
    ], "rejected");
  });

  it("awaiting-approval wins over a stale expired row when an actionable one exists", () => {
    expectState(true, [
      approval("pending", { id: "stale", expiresAt: "2026-09-09T11:30:00.000Z" }),
      approval("pending", { id: "live", expiresAt: "2026-09-09T14:00:00.000Z" }),
    ], "awaiting-approval");
  });

  it("boundary — an expiry instant now == expiresAt is NOT actionable, so it derives expired", () => {
    expectState(true, [approval("pending", { expiresAt: "2026-09-09T12:00:00.000Z" })], "expired");
  });
});

describe("listAiConversations — turn-state enrichment (Phase 10.31)", () => {
  it("surfaces awaiting-approval with the actionable approvals for the listed members", async () => {
    mocks.listAgentConversations.mockResolvedValue([
      {
        ...BASE_CONVERSATION,
        updatedAt: new Date("2026-01-03T00:00:00Z"),
      },
    ] as unknown as Awaited<ReturnType<typeof mocks.listAgentConversations>>);
    mocks.listConversationLastMessages.mockResolvedValue([
      { conversationId: CONVERSATION_ID, messageId: "final-1", role: "assistant", isFinal: true },
    ]);
    mocks.listConversationToolApprovals.mockResolvedValue([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        conversationId: CONVERSATION_ID,
        messageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        toolName: "delete_file",
        arguments: { path: "/reports/old.txt", permanent: true },
        status: "pending",
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T01:00:00.000Z",
        decidedAt: null,
      },
    ]);

    const rows = await listAiConversations(ALICE);

    // The live pending approval outranks the final reply → awaiting-approval,
    // and the actionable approval is projected (the stale user id is dropped
    // by the safe projection, which the service test relies on by contract).
    expect(rows[0]?.turnState).toBe("awaiting-approval");
    expect(rows[0]?.pendingApprovals).toEqual([
      expect.objectContaining({ status: "pending", toolName: "delete_file" }),
    ]);
  });

  it("derives completed vs failed per conversation from the last message, with no approvals", async () => {
    mocks.listAgentConversations.mockResolvedValue([
      {
        ...BASE_CONVERSATION,
        id: CONVERSATION_ID,
        updatedAt: new Date("2026-01-03T00:00:00Z"),
      },
      {
        ...BASE_CONVERSATION,
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        title: null,
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    ] as unknown as Awaited<ReturnType<typeof mocks.listAgentConversations>>);
    mocks.listConversationLastMessages.mockResolvedValue([
      { conversationId: CONVERSATION_ID, messageId: "final-1", role: "assistant", isFinal: true },
    ]);

    const rows = await listAiConversations(ALICE);

    expect(rows[0]?.turnState).toBe("completed");
    expect(rows[0]?.pendingApprovals).toEqual([]);
    // The second conversation's final transcript row is a still-running
    // assistant fragment (no final reply) → failed, not completed.
    expect(rows[1]?.turnState).toBe("failed");
    expect(rows[1]?.pendingApprovals).toEqual([]);
  });
});

describe("getAiConversation — turn-state enrichment (Phase 10.31)", () => {
  const DETAIL_MESSAGES = [
    storedMessage({ createdAt: new Date("2026-01-01T00:00:01Z") }),
    storedMessage({
      id: "msg-2",
      role: "assistant",
      content: "Done.",
      isFinal: true,
      createdAt: new Date("2026-01-01T00:00:02Z"),
    }),
  ];

  it("surfaces an awaiting-approval detail with the actionable approvals", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: DETAIL_MESSAGES,
    });
    mocks.listConversationLastMessages.mockResolvedValue([
      { conversationId: CONVERSATION_ID, messageId: "msg-2", role: "assistant", isFinal: true },
    ]);
    mocks.listConversationToolApprovals.mockResolvedValue([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        conversationId: CONVERSATION_ID,
        messageId: "msg-1",
        toolName: "delete_file",
        arguments: { path: "/reports/old.txt" },
        status: "pending",
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T01:00:00.000Z",
        decidedAt: null,
      },
    ]);

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);

    expect(detail.turnState).toBe("awaiting-approval");
    expect(detail.pendingApprovals).toHaveLength(1);
    // The transcript is preserved unmodified.
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(mocks.listConversationToolApprovals).toHaveBeenCalledWith(ALICE, [CONVERSATION_ID]);
    expect(mocks.listConversationLastMessages).toHaveBeenCalledWith(ALICE, [CONVERSATION_ID]);
  });

  it("reports approved after approve+resume — the consumed approval predates the resumed reply", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: DETAIL_MESSAGES,
    });
    mocks.listConversationToolApprovals.mockResolvedValue([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        conversationId: CONVERSATION_ID,
        messageId: "msg-0",
        toolName: "delete_file",
        arguments: { path: "/reports/old.txt" },
        status: "approved",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
        decidedAt: "2026-01-01T00:00:03.000Z",
      },
    ]);

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);

    // Filtering by the last segment's message id would misclassify this as
    // completed; using ALL of the conversation's approvals keeps it approved.
    expect(detail.turnState).toBe("approved");
    expect(detail.pendingApprovals).toEqual([]);
  });

  it("keeps completed for a final reply with no approvals", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: DETAIL_MESSAGES,
    });
    mocks.listConversationLastMessages.mockResolvedValue([
      { conversationId: CONVERSATION_ID, messageId: "msg-2", role: "assistant", isFinal: true },
    ]);

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);

    expect(detail.turnState).toBe("completed");
    expect(detail.pendingApprovals).toEqual([]);
  });

  it("reports expired for a pending approval that outlived its window, with nothing actionable", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: DETAIL_MESSAGES,
    });
    const expired = new Date(Date.now() - 60_000);
    mocks.listConversationToolApprovals.mockResolvedValue([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        conversationId: CONVERSATION_ID,
        messageId: "msg-1",
        toolName: "delete_file",
        arguments: { path: "/reports/old.txt" },
        status: "pending",
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        updatedAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: expired.toISOString(),
        decidedAt: null,
      },
    ]);

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);

    // The stale pending row is NOT surfaced as actionable and the derivation
    // reduces it to `expired`.
    expect(detail.turnState).toBe("expired");
    expect(detail.pendingApprovals).toEqual([]);
  });

  it("returns the 404 before any approval or last-message query for a foreign/missing conversation", async () => {
    mocks.getAgentConversation.mockResolvedValue(null);

    await expect(getAiConversation(ALICE, CONVERSATION_ID)).rejects.toMatchObject({
      status: 404,
      code: "common/not-found",
    });
    expect(mocks.getAgentConversation).toHaveBeenCalledTimes(1);
    expect(mocks.listConversationToolApprovals).not.toHaveBeenCalled();
    expect(mocks.listConversationLastMessages).not.toHaveBeenCalled();
  });
});