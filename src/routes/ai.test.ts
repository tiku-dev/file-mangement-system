/**
 * AI route tests (Phase 10.21 status + Phase 10.22 instructions).
 *
 * These integration tests drive the REAL `aiRoutes` (`GET /api/ai/status` +
 * `POST /api/ai/instructions`) with the REAL `requireAuth` middleware and the
 * real `onError` envelope. The session repository, DB clock, the AI status
 * SERVICE, and the instruction SERVICE are mocked so the tests stay
 * deterministic and offline.
 *
 * Coverage:
 *
 *   1. Authenticated request → 200 with the stable payload.
 *   2. Any authenticated user receives the SAME safe payload (identity is
 *      authorization-only, never trusted from the request).
 *   3. Unauthenticated request → existing generic 401 auth/unauthorized.
 *   4. Existing auth behavior unchanged: malformed token, inactive user, and
 *      expired session all collapse to the same generic 401.
 *   5. Stable response shape at the HTTP boundary.
 *   6. No network request is performed while serving.
 *   7. POST /instructions: authenticated 200 envelope passthrough; the real
 *      strict body parser stays authoritative IN the route path (rejects
 *      body-supplied identity); malformed JSON → 400; unexpected service
 *      errors → generic 500 `internal/error` WITHOUT leaking internals; and
 *      the same 401 behavior as the status route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { onError } from "../core/http.js";
import { AppError } from "../core/errors.js";
import { aiRoutes } from "./ai.js";
import type { AiRuntimeStatus } from "../services/aiStatus.js";
import type { AiInstructionResponse } from "../services/aiInstructions.js";
import { parseAiInstructionInput } from "../services/aiInstructions.js";
import type {
  AiConversationArchiveResult,
  AiConversationDeletionResult,
  AiConversationDetail,
  AiConversationSummary,
} from "../services/aiConversations.js";
import type { AiToolApproval } from "../services/aiToolApprovals.js";
import { validateConversationId } from "../services/conversationId.js";

// ---------------------------------------------------------------------------
// Mocked dependencies
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  findSessionByTokenHash: vi.fn(),
  updateSessionLastUsedAt: vi.fn(),
  databaseNow: vi.fn(),
  getAiRuntimeStatus: vi.fn(),
  runAiInstruction: vi.fn(),
  listAiConversations: vi.fn(),
  getAiConversation: vi.fn(),
  deleteAiConversation: vi.fn(),
  renameAiConversation: vi.fn(),
  archiveAiConversation: vi.fn(),
  unarchiveAiConversation: vi.fn(),
}));

vi.mock("../database/repositories/sessions.js", () => ({
  createSession: vi.fn(),
  findSessionByTokenHash: mocks.findSessionByTokenHash,
  updateSessionLastUsedAt: mocks.updateSessionLastUsedAt,
  deleteSessionByTokenHash: vi.fn(),
}));

vi.mock("../database/client.js", () => ({
  databaseNow: mocks.databaseNow,
}));

vi.mock("../services/aiStatus.js", () => ({
  getAiRuntimeStatus: mocks.getAiRuntimeStatus,
}));

vi.mock("../services/aiInstructions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/aiInstructions.js")>();
  return {
    ...actual,
    // The production entry is replaced; the REAL strict parser stays in the
    // pipeline so validation behavior is exercised end-to-end.
    runAiInstruction: mocks.runAiInstruction,
  };
});

vi.mock("../services/aiConversations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/aiConversations.js")>();
  return {
    ...actual,
    // Production entries replaced; the REAL shared conversationId validator
    // stays in the pipeline so path-param validation is exercised end-to-end
    // (malformed ids reach the 400 envelope through the service contract).
    listAiConversations: mocks.listAiConversations,
    getAiConversation: mocks.getAiConversation,
    deleteAiConversation: mocks.deleteAiConversation,
    renameAiConversation: mocks.renameAiConversation,
    archiveAiConversation: mocks.archiveAiConversation,
    unarchiveAiConversation: mocks.unarchiveAiConversation,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

const OTHER_ACTIVE_USER = {
  id: "33333333-3333-3333-3333-333333333333",
  email: "carol@example.com",
  displayName: "Carol Example",
  status: "active",
};

const PENDING_USER = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob Example",
  status: "pending",
};

function sessionFor(user: { id: string; email: string; displayName: string; status: string }): unknown {
  return {
    id: "session-1",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    user,
  };
}

const CANNED_STATUS: AiRuntimeStatus = {
  status: "ok",
  providers: [
    {
      provider: "grok",
      order: 0,
      enabled: true,
      validationStatus: "valid",
      model: "grok-3",
      credentialCount: 2,
      credentialFree: false,
      issues: [],
    },
    {
      provider: "ollama",
      order: 1,
      enabled: true,
      validationStatus: "valid",
      model: "qwen3",
      credentialCount: 0,
      credentialFree: true,
      issues: [],
    },
  ],
};

const HISTORY_CONVERSATION_ID = "55555555-5555-5555-5555-555555555555";

const CANNED_SUMMARY: AiConversationSummary = {
  id: HISTORY_CONVERSATION_ID,
  title: "Invoice review",
  maxToolRounds: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-03T00:00:00.000Z",
  turnState: "completed",
  pendingApprovals: [],
};

const CANNED_DETAIL: AiConversationDetail = {
  ...CANNED_SUMMARY,
  messages: [
    {
      id: "msg-1",
      role: "user",
      content: "List my files.",
      createdAt: "2026-01-01T00:00:01.000Z",
      isFinal: false,
    },
    {
      id: "msg-2",
      role: "assistant",
      content: "Done.",
      createdAt: "2026-01-01T00:00:02.000Z",
      isFinal: true,
    },
  ],
};

/** Tracks owned ids already deleted this test (default delete mock → repeated 404). */
const deleteCounts = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  // Every test starts WITHOUT a session; authenticated tests opt in. This
  // prevents a persistent `mockResolvedValue` from a sibling test leaking.
  mocks.findSessionByTokenHash.mockReset();
  deleteCounts.clear();
  mocks.updateSessionLastUsedAt.mockResolvedValue(undefined);
  mocks.databaseNow.mockResolvedValue(new Date("2026-01-01T00:00:00Z"));
  mocks.getAiRuntimeStatus.mockReturnValue(CANNED_STATUS);
  mocks.runAiInstruction.mockImplementation(
    async (c: { get: (key: string) => unknown }, raw: unknown): Promise<AiInstructionResponse> => {
      // The real strict parser runs; the turn result itself is canned.
      const input = parseAiInstructionInput(raw);
      return {
        conversationId: input.conversationId ?? "22222222-2222-2222-2222-222222222222",
        turn: {
          created: input.conversationId === undefined,
          instruction: input.instruction,
          messages: [],
          finalText: "Everything listed.",
          toolRounds: 0,
          maxToolRounds: 3,
          toolResults: [],
          pendingApprovals: [],
        },
      };
    },
  );
  mocks.listAiConversations.mockImplementation(async (userId: string, _q?: string) => {
    // The route consults ONLY the session user; canned ownership check. The
    // optional Phase 10.27 search query is forwarded to (and validated by) the
    // real service — this route-level mock only proves passthrough + scoping.
    if (userId !== ACTIVE_USER.id) return [];
    return [CANNED_SUMMARY];
  });
  mocks.getAiConversation.mockImplementation(
    async (userId: string, conversationId: string): Promise<AiConversationDetail> => {
      // The REAL shared UUID validator runs → malformed ids get 400.
      validateConversationId(conversationId);
      if (conversationId !== HISTORY_CONVERSATION_ID) {
        throw AppError.notFound("Agent conversation");
      }
      if (userId !== ACTIVE_USER.id) {
        throw AppError.notFound("Agent conversation");
      }
      return CANNED_DETAIL;
    },
  );
  mocks.deleteAiConversation.mockImplementation(
    async (userId: string, conversationId: string): Promise<AiConversationDeletionResult> => {
      // The REAL shared UUID validator runs → malformed ids get 400; owned
      // ids delete with the small stable result; foreign/missing collapse to
      // the same 404. A single owned id can be deleted exactly once — the
      // default impl flags repeated deletes so route tests exercise the
      // "repeated deletion → 404" contract without extra orchestration.
      validateConversationId(conversationId);
      if (conversationId !== HISTORY_CONVERSATION_ID || userId !== ACTIVE_USER.id) {
        throw AppError.notFound("Agent conversation");
      }
      if (deleteCounts.has(conversationId)) {
        throw AppError.notFound("Agent conversation");
      }
      deleteCounts.add(conversationId);
      return { conversationId, deleted: true };
    },
  );
  mocks.renameAiConversation.mockImplementation(
    async (userId: string, conversationId: string, title: string) => {
      // The REAL shared UUID validator runs → malformed ids get 400; owned
      // ids rename with the stable result; foreign/missing collapse to the
      // same 404. The real strict body parser in the route already validates
      // the title upstream — the mock only enforces ownership.
      validateConversationId(conversationId);
      if (conversationId !== HISTORY_CONVERSATION_ID || userId !== ACTIVE_USER.id) {
        throw AppError.notFound("Agent conversation");
      }
      return { conversationId, title };
    },
  );
  mocks.archiveAiConversation.mockImplementation(
    async (userId: string, conversationId: string): Promise<AiConversationArchiveResult> => {
      // The REAL shared UUID validator runs → malformed ids get 400; owned
      // ids archive with the stable safe metadata; foreign/missing collapse
      // to the same 404.
      validateConversationId(conversationId);
      if (conversationId !== HISTORY_CONVERSATION_ID || userId !== ACTIVE_USER.id) {
        throw AppError.notFound("Agent conversation");
      }
      return {
        conversationId,
        title: CANNED_SUMMARY.title,
        archivedAt: "2026-01-04T00:00:00.000Z",
      };
    },
  );
  mocks.unarchiveAiConversation.mockImplementation(
    async (userId: string, conversationId: string): Promise<AiConversationArchiveResult> => {
      // The REAL shared UUID validator runs → malformed ids get 400; owned
      // ids unarchive with archivedAt null; foreign/missing collapse to the
      // same 404.
      validateConversationId(conversationId);
      if (conversationId !== HISTORY_CONVERSATION_ID || userId !== ACTIVE_USER.id) {
        throw AppError.notFound("Agent conversation");
      }
      return { conversationId, title: CANNED_SUMMARY.title, archivedAt: null };
    },
  );
});

/** Mount the REAL aiRoutes (as under `/api/ai`) + auth + error envelope. */
function makeApp(): Hono {
  const app = new Hono();
  app.onError(onError);
  app.route("/api/ai", aiRoutes);
  return app;
}

function authorizedHeaders(token = "valid-token"): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// 1 & 2. Authenticated access
// ---------------------------------------------------------------------------

describe("GET /api/ai/status — authenticated", () => {
  it("returns 200 with the stable status payload for an authenticated user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request("/api/ai/status", {
      method: "GET",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(CANNED_STATUS);
    expect(mocks.getAiRuntimeStatus).toHaveBeenCalledTimes(1);
  });

  it("gives every authenticated user the same safe payload", async () => {
    mocks.findSessionByTokenHash.mockResolvedValueOnce(sessionFor(ACTIVE_USER));
    mocks.findSessionByTokenHash.mockResolvedValueOnce(sessionFor(OTHER_ACTIVE_USER));

    const app = makeApp();
    const first = await (await app.request("/api/ai/status", { headers: authorizedHeaders("a") })).json();
    const second = await (await app.request("/api/ai/status", { headers: authorizedHeaders("b") })).json();

    expect(second).toEqual(first);
    // The payload is identity-independent: it never echoes the session user.
    expect(JSON.stringify(first)).not.toContain(ACTIVE_USER.id);
    expect(JSON.stringify(first)).not.toContain(OTHER_ACTIVE_USER.id);
    expect(JSON.stringify(first)).not.toContain("alice@example.com");
    expect(JSON.stringify(first)).not.toContain("carol@example.com");
  });

  it("returns a stable, explicitly typed response shape", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const body = (await (await makeApp().request("/api/ai/status", { headers: authorizedHeaders() })).json()) as AiRuntimeStatus;

    expect(Object.keys(body).sort()).toEqual(["providers", "status"]);
    expect(body.providers).toHaveLength(2);
    for (const provider of body.providers) {
      expect(typeof provider.provider).toBe("string");
      expect(Number.isInteger(provider.order)).toBe(true);
      expect(typeof provider.enabled).toBe("boolean");
      expect(["valid", "disabled"]).toContain(provider.validationStatus);
      expect(typeof provider.credentialCount).toBe("number");
      expect(typeof provider.credentialFree).toBe("boolean");
      expect(Array.isArray(provider.issues)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Existing auth behavior unchanged (generic 401)
// ---------------------------------------------------------------------------

describe("GET /api/ai/status — authentication failures", () => {
  it("returns the existing generic 401 for a missing token", async () => {
    const res = await makeApp().request("/api/ai/status", { method: "GET" });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "auth/unauthorized", message: "Invalid email or password." },
    });
    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for a malformed bearer header", async () => {
    const app = makeApp();

    for (const headers of [
      { authorization: "Basic abc123" },
      { authorization: "Bearer" },
      { authorization: "Bearer one two" },
    ]) {
      const res = await app.request("/api/ai/status", { headers });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "auth/unauthorized" },
      });
    }

    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an inactive user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(PENDING_USER));

    const res = await makeApp().request("/api/ai/status", { headers: authorizedHeaders() });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an expired session", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue({
      id: "session-expired",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      user: ACTIVE_USER,
    });

    const res = await makeApp().request("/api/ai/status", { headers: authorizedHeaders() });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an unknown token", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(null);

    const res = await makeApp().request("/api/ai/status", { headers: authorizedHeaders() });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. No network
// ---------------------------------------------------------------------------

describe("GET /api/ai/status — no network", () => {
  it("performs no network request while serving status", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await makeApp().request("/api/ai/status", { headers: authorizedHeaders() });

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// 7. POST /api/ai/instructions
// ---------------------------------------------------------------------------

describe("POST /api/ai/instructions — authenticated", () => {
  async function postInstruction(app: Hono, body: unknown, token = "valid-token"): Promise<Response> {
    return app.request("/api/ai/instructions", {
      method: "POST",
      headers: {
        ...authorizedHeaders(token),
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("returns 200 with the stable typed envelope for an authenticated user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await postInstruction(makeApp(), {
      instruction: "List my home directory.",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as AiInstructionResponse;
    expect(Object.keys(body).sort()).toEqual(["conversationId", "turn"]);
    expect(Object.keys(body.turn).sort()).toEqual(
      ["created", "finalText", "instruction", "maxToolRounds", "messages", "pendingApprovals", "toolResults", "toolRounds"].sort(),
    );
    expect(body.turn.instruction).toBe("List my home directory.");
    expect(body.conversationId).toBe("22222222-2222-2222-2222-222222222222");
    expect(mocks.runAiInstruction).toHaveBeenCalledTimes(1);
  });

  it("resumes the conversation when a valid conversationId is supplied", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const conversationId = "44444444-4444-4444-4444-444444444444";

    const body = (await (
      await postInstruction(makeApp(), { conversationId, instruction: "Continue listing." })
    ).json()) as AiInstructionResponse;

    expect(body.conversationId).toBe(conversationId);
    expect(body.turn.created).toBe(false);
  });

  it("rejects a body that tries to supply its own identity (400 common/bad-request)", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await postInstruction(makeApp(), {
      instruction: "Read my /etc file.",
      userId: "99999999-9999-9999-9999-999999999999",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "common/bad-request" },
    });
  });

  it("ignores a supplied identity when the session owns the user (defense test)", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.runAiInstruction.mockImplementationOnce(
      async (c: { get: (key: string) => unknown }, raw: unknown) => {
        // The only identity the service ever sees is the SESION user.
        expect((c.get("user") as { email: string }).email).toBe("alice@example.com");
        const input = parseAiInstructionInput(raw);
        return {
          conversationId: "22222222-2222-2222-2222-222222222222",
          turn: {
            created: true,
            instruction: input.instruction,
            messages: [],
            toolRounds: 0,
            maxToolRounds: 3,
            toolResults: [],
          },
        };
      },
    );

    const res = await postInstruction(makeApp(), {
      instruction: "List my home directory.",
    });

    expect(res.status).toBe(200);
  });

  it("returns 400 common/bad-request for malformed JSON before any agent work", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await postInstruction(makeApp(), "{ this is not json ");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "Request body must be valid JSON." },
    });
    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/instructions — generic 500 without leaks", () => {
  it("reduces an unexpected service error to the generic internal/error envelope", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.runAiInstruction.mockRejectedValueOnce(
      new Error("SECRET provider key sk-LIVE-leak inside backend internal path"),
    );

    const res = await (
      await makeApp().request("/api/ai/instructions", {
        method: "POST",
        headers: { ...authorizedHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ instruction: "List my home directory." }),
      })
    ).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("sk-LIVE");
  });
});

describe("POST /api/ai/instructions — authentication failures (unchanged)", () => {
  it("returns the existing generic 401 for a missing token", async () => {
    const res = await makeApp().request("/api/ai/instructions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "List my home directory." }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "auth/unauthorized", message: "Invalid email or password." },
    });
    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for a malformed bearer header", async () => {
    const app = makeApp();

    for (const headers of [
      { authorization: "Bearer" },
      { authorization: "Bearer one two" },
    ]) {
      const res = await app.request("/api/ai/instructions", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ instruction: "List my home directory." }),
      });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    }

    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an unknown token", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(null);

    const res = await makeApp().request("/api/ai/instructions", {
      method: "POST",
      headers: { ...authorizedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "List my home directory." }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/instructions — no network", () => {
  it("performs no network request while serving an instruction", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await (
      await makeApp().request("/api/ai/instructions", {
        method: "POST",
        headers: { ...authorizedHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ instruction: "List my home directory." }),
      })
    ).json();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect((res as AiInstructionResponse).turn.instruction).toBe("List my home directory.");
  });
});

// ---------------------------------------------------------------------------
// 8. GET /api/ai/conversations — history list (Phase 10.23)
// ---------------------------------------------------------------------------

describe("GET /api/ai/conversations — authenticated", () => {
  it("returns 200 with the stable list shape for an authenticated user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request("/api/ai/conversations", {
      method: "GET",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as AiConversationSummary[];
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toEqual(CANNED_SUMMARY);
    expect(mocks.listAiConversations).toHaveBeenCalledTimes(1);
  });

  it("scopes the list to the SESSION user — request identity is ignored", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      "/api/ai/conversations?userId=99999999-9999-9999-9999-999999999999&user=attacker",
      { method: "GET", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    // The route consults only the authenticated session identity.
    expect(mocks.listAiConversations).toHaveBeenCalledWith(ACTIVE_USER.id);
  });

  it("returns a valid empty array for a user with no conversations", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(OTHER_ACTIVE_USER));

    const body = (await (
      await makeApp().request("/api/ai/conversations", { method: "GET", headers: authorizedHeaders() })
    ).json()) as AiConversationSummary[];

    expect(body).toEqual([]);
  });
});

describe("GET /api/ai/conversations — title search (Phase 10.27)", () => {
  it("forwards a present q to the service for the authenticated session user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request("/api/ai/conversations?q=Invoice%20Review", {
      method: "GET",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as AiConversationSummary[];
    expect(Array.isArray(body)).toBe(true);
    // The route forwards the raw query string; trimming/validation/search live
    // in the service/repository.
    expect(mocks.listAiConversations).toHaveBeenCalledWith(ACTIVE_USER.id, "Invoice Review");
  });

  it("decodes and forwards URL-encoded search terms", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request("/api/ai/conversations?q=100%25%20done%26more", {
      method: "GET",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    expect(mocks.listAiConversations).toHaveBeenCalledWith(ACTIVE_USER.id, "100% done&more");
  });

  it("keeps searching scoped to the SESSION user even with a query present", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      "/api/ai/conversations?q=Invoice&userId=99999999-9999-9999-9999-999999999999",
      { method: "GET", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    // Request-supplied identity is ignored entirely.
    expect(mocks.listAiConversations).toHaveBeenCalledWith(ACTIVE_USER.id, "Invoice");
  });

  it("returns the empty list for a user whose search matches nothing", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(OTHER_ACTIVE_USER));

    const body = (await (
      await makeApp().request("/api/ai/conversations?q=zebra", {
        method: "GET",
        headers: authorizedHeaders(),
      })
    ).json()) as AiConversationSummary[];

    expect(body).toEqual([]);
    expect(mocks.listAiConversations).toHaveBeenCalledWith(OTHER_ACTIVE_USER.id, "zebra");
  });

  it("passes an empty and a whitespace-only q through untouched", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    for (const q of ["", "%20%20"]) {
      const res = await makeApp().request(`/api/ai/conversations?q=${q}`, {
        method: "GET",
        headers: authorizedHeaders(),
      });
      expect(res.status).toBe(200);
    }

    // The route never trims; the service turns empty/whitespace into "no query".
    expect(mocks.listAiConversations).toHaveBeenCalledWith(ACTIVE_USER.id, "");
    expect(mocks.listAiConversations).toHaveBeenCalledWith(ACTIVE_USER.id, "  ");
  });

  it("calls the service with NO query argument when q is absent", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    await makeApp().request("/api/ai/conversations", { method: "GET", headers: authorizedHeaders() });

    expect(mocks.listAiConversations).toHaveBeenCalledWith(ACTIVE_USER.id);
  });

  it("returns the existing generic 401 for search requests without a session", async () => {
    const res = await makeApp().request("/api/ai/conversations?q=Invoice", {
      headers: { authorization: "Bearer unknown" },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.listAiConversations).not.toHaveBeenCalled();
  });

  it("reduces an unexpected search failure to internal/error without leaks", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.listAiConversations.mockRejectedValueOnce(
      new Error("SECRET credential handle credential-77 leaked at /Users/builder/src/search.ts:3"),
    );

    const res = await (await makeApp().request("/api/ai/conversations?q=Invoice", {
      method: "GET",
      headers: authorizedHeaders(),
    })).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("credential-77");
    expect(JSON.stringify(res)).not.toContain("/Users/builder");
  });

  it("performs no provider or network call while searching", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await makeApp().request("/api/ai/conversations?q=Invoice", {
      method: "GET",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});

describe("GET /api/ai/conversations — authentication failures (unchanged)", () => {
  it("returns the existing generic 401 for missing/malformed/unknown tokens", async () => {
    const app = makeApp();

    for (const headers of [undefined, { authorization: "Bearer x y" }, authorizedHeaders("unknown")]) {
      const res = await app.request("/api/ai/conversations", { headers });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    }

    expect(mocks.listAiConversations).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. GET /api/ai/conversations/:conversationId — history detail (Phase 10.23)
// ---------------------------------------------------------------------------

describe("GET /api/ai/conversations/:conversationId — authenticated", () => {
  it("returns 200 with the stable detail shape for an owned conversation", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "GET", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as AiConversationDetail;
    expect(body).toEqual(CANNED_DETAIL);
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(body.messages.map((m) => m.isFinal)).toEqual([false, true]);
    expect(mocks.getAiConversation).toHaveBeenCalledWith(ACTIVE_USER.id, HISTORY_CONVERSATION_ID);
  });

  it("returns the same generic 404 for a foreign and a nonexistent conversation", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const app = makeApp();

    const foreignRes = await app.request(
      "/api/ai/conversations/99999999-9999-9999-9999-999999999999", // owned by someone else
      { headers: authorizedHeaders() },
    );
    const missingRes = await app.request(
      "/api/ai/conversations/00000000-0000-0000-0000-000000000000",
      { headers: authorizedHeaders() },
    );

    const foreign = await foreignRes.json();
    const missing = await missingRes.json();
    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
      error: { code: "common/not-found", message: "Agent conversation was not found." },
    });
    expect(foreignRes.status).toBe(404);
  });

  it("rejects a malformed conversationId with the existing 400 envelope", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      "/api/ai/conversations/not-a-uuid!",
      { headers: authorizedHeaders() },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "A valid conversationId is required." },
    });
  });
});

describe("GET /api/ai/conversations/:conversationId — authentication failures (unchanged)", () => {
  it("returns the existing generic 401 without calling the service", async () => {
    const app = makeApp();

    for (const headers of [undefined, { authorization: "Basic abc" }, authorizedHeaders("unknown")]) {
      const res = await app.request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
        { headers },
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    }

    expect(mocks.getAiConversation).not.toHaveBeenCalled();
  });
});

describe("GET /api/ai/conversations — unexpected failures use the generic envelope", () => {
  it("reduces a raw repository error to internal/error without leaking internals", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.listAiConversations.mockRejectedValueOnce(
      new Error("SECRET provider key sk-LIVE-leak at /Users/builder/src/db.ts:12"),
    );

    const res = await (
      await makeApp().request("/api/ai/conversations", { method: "GET", headers: authorizedHeaders() })
    ).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("sk-LIVE");
    expect(JSON.stringify(res)).not.toContain("/Users/builder");
  });

  it("reduces a raw service error in the detail route the same way", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.getAiConversation.mockRejectedValueOnce(
      new Error("SECRET credential handle credential-99 leaked"),
    );

    const res = await (
      await makeApp().request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
        { method: "GET", headers: authorizedHeaders() },
      )
    ).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("credential-99");
  });
});

describe("GET /api/ai/conversations — no network / no provider invocation", () => {
  it("performs no provider or network call while listing and reading history", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = makeApp();

    const listRes = await app.request("/api/ai/conversations", { headers: authorizedHeaders() });
    const detailRes = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { headers: authorizedHeaders() },
    );

    expect(listRes.status).toBe(200);
    expect(detailRes.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// 10. DELETE /api/ai/conversations/:conversationId — deletion (Phase 10.24)
// ---------------------------------------------------------------------------

describe("DELETE /api/ai/conversations/:conversationId — authenticated", () => {
  it("returns 200 with the SMALL STABLE success result for an owned conversation", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "DELETE", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as AiConversationDeletionResult;
    // Never the deleted transcript/contents — just confirmation + the id.
    expect(body).toEqual({ conversationId: HISTORY_CONVERSATION_ID, deleted: true });
    expect(mocks.deleteAiConversation).toHaveBeenCalledWith(
      ACTIVE_USER.id,
      HISTORY_CONVERSATION_ID,
    );
  });

  it("scopes identity to the authenticated SESSION — request identity is ignored", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}?userId=99999999-9999-9999-9999-999999999999&user=attacker`,
      { method: "DELETE", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    // The route consults only the session user; the request cannot self-identify.
    expect(mocks.deleteAiConversation).toHaveBeenCalledWith(
      ACTIVE_USER.id,
      HISTORY_CONVERSATION_ID,
    );
  });
});

describe("DELETE /api/ai/conversations/:conversationId — ownership & 404 contract", () => {
  it("returns the same generic 404 for a foreign and a nonexistent conversation", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const app = makeApp();

    const foreignRes = await app.request(
      "/api/ai/conversations/99999999-9999-9999-9999-999999999999", // owned by someone else
      { method: "DELETE", headers: authorizedHeaders() },
    );
    const missingRes = await app.request(
      "/api/ai/conversations/00000000-0000-0000-0000-000000000000",
      { method: "DELETE", headers: authorizedHeaders() },
    );

    const foreign = await foreignRes.json();
    const missing = await missingRes.json();
    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
      error: { code: "common/not-found", message: "Agent conversation was not found." },
    });
    expect(foreignRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    // Both attempts were scoped to the SESSION user — never another identity.
    expect(mocks.deleteAiConversation).toHaveBeenNthCalledWith(
      1,
      ACTIVE_USER.id,
      "99999999-9999-9999-9999-999999999999",
    );
    expect(mocks.deleteAiConversation).toHaveBeenNthCalledWith(
      2,
      ACTIVE_USER.id,
      "00000000-0000-0000-0000-000000000000",
    );
  });

  it("treats a repeated deletion of an already-deleted conversation as the same 404", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const app = makeApp();

    const first = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "DELETE", headers: authorizedHeaders() },
    );
    const second = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "DELETE", headers: authorizedHeaders() },
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      conversationId: HISTORY_CONVERSATION_ID,
      deleted: true,
    });
    expect(second.status).toBe(404);
    await expect(second.json()).resolves.toEqual({
      error: { code: "common/not-found", message: "Agent conversation was not found." },
    });
  });

  it("rejects a malformed conversationId with the existing 400 envelope before any delete", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      "/api/ai/conversations/not-a-uuid!",
      { method: "DELETE", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "A valid conversationId is required." },
    });
    // The REAL shared validator runs inside the service pipeline — the
    // malformed id reaches the service (which throws the existing 400) and is
    // never passed toward anything destructive.
    expect(mocks.deleteAiConversation).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAiConversation).toHaveBeenCalledWith(ACTIVE_USER.id, "not-a-uuid!");
  });
});

describe("DELETE /api/ai/conversations/:conversationId — authentication failures (unchanged)", () => {
  it("returns the existing generic 401 without calling the service", async () => {
    const app = makeApp();

    for (const headers of [undefined, { authorization: "Bearer x y" }, authorizedHeaders("unknown")]) {
      const res = await app.request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
        { method: "DELETE", headers },
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    }

    expect(mocks.deleteAiConversation).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/ai/conversations/:conversationId — unexpected failures use the generic envelope", () => {
  it("reduces a raw service error to internal/error without leaking internals or contents", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.deleteAiConversation.mockRejectedValueOnce(
      new Error("SECRET credential handle credential-99 leaked from /Users/builder/src/db.ts:12"),
    );

    const res = await (
      await makeApp().request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
        { method: "DELETE", headers: authorizedHeaders() },
      )
    ).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("credential-99");
    expect(JSON.stringify(res)).not.toContain("/Users/builder");
  });
});

describe("DELETE /api/ai/conversations/:conversationId — no network / no provider invocation", () => {
  it("performs no provider or network call while deleting", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = makeApp();

    const res = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "DELETE", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 11. PATCH /api/ai/conversations/:conversationId — rename (Phase 10.25)
// ---------------------------------------------------------------------------

describe("PATCH /api/ai/conversations/:conversationId — authenticated", () => {
  async function patchRename(app: Hono, conversationId: string, body: unknown, token = "valid-token"): Promise<Response> {
    return app.request(`/api/ai/conversations/${conversationId}`, {
      method: "PATCH",
      headers: {
        ...authorizedHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("returns 200 with the stable title result for an owned conversation", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await patchRename(makeApp(), HISTORY_CONVERSATION_ID, { title: "New title" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { conversationId: string; title: string };
    expect(body).toEqual({ conversationId: HISTORY_CONVERSATION_ID, title: "New title" });
    expect(mocks.renameAiConversation).toHaveBeenCalledWith(
      ACTIVE_USER.id,
      HISTORY_CONVERSATION_ID,
      "New title",
    );
  });

  it("scopes identity to the authenticated SESSION — request identity is ignored", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await patchRename(
      makeApp(),
      `${HISTORY_CONVERSATION_ID}?userId=99999999-9999-9999-9999-999999999999&user=attacker`,
      { title: "New title" },
    );

    expect(res.status).toBe(200);
    // The route consults only the session user; the request cannot self-identify.
    expect(mocks.renameAiConversation).toHaveBeenCalledWith(
      ACTIVE_USER.id,
      HISTORY_CONVERSATION_ID,
      "New title",
    );
  });
});

describe("PATCH /api/ai/conversations/:conversationId — body validation", () => {
  async function patchRename(app: Hono, conversationId: string, body: unknown, token = "valid-token"): Promise<Response> {
    return app.request(`/api/ai/conversations/${conversationId}`, {
      method: "PATCH",
      headers: {
        ...authorizedHeaders(token),
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("rejects malformed JSON with 400 common/bad-request", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await patchRename(makeApp(), HISTORY_CONVERSATION_ID, "{ not json ", "valid-token");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "Request body must be valid JSON." },
    });
    expect(mocks.renameAiConversation).not.toHaveBeenCalled();
  });

  it("rejects a non-object body (array) with 400 common/bad-request", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await patchRename(makeApp(), HISTORY_CONVERSATION_ID, ["title"]);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "Request body must be a JSON object." },
    });
    expect(mocks.renameAiConversation).not.toHaveBeenCalled();
  });

  it("rejects a non-object body (string) with 400 common/bad-request", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    // Send a JSON-encoded string — valid JSON but not an object.
    const res = await patchRename(makeApp(), HISTORY_CONVERSATION_ID, JSON.stringify("just a string"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "Request body must be a JSON object." },
    });
    expect(mocks.renameAiConversation).not.toHaveBeenCalled();
  });

  it("rejects extra body fields beyond title with 400 common/bad-request", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await patchRename(makeApp(), HISTORY_CONVERSATION_ID, {
      title: "New",
      userId: "99999999-9999-9999-9999-999999999999",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "Only the title field is accepted." },
    });
    expect(mocks.renameAiConversation).not.toHaveBeenCalled();
  });

  it("rejects a body with no title field with 400 common/bad-request", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await patchRename(makeApp(), HISTORY_CONVERSATION_ID, { other: "value" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "Only the title field is accepted." },
    });
    expect(mocks.renameAiConversation).not.toHaveBeenCalled();
  });

  it("rejects an empty object body with 400 common/bad-request", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await patchRename(makeApp(), HISTORY_CONVERSATION_ID, {});

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "Only the title field is accepted." },
    });
    expect(mocks.renameAiConversation).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/ai/conversations/:conversationId — ownership & 404 contract", () => {
  async function patchRename(app: Hono, conversationId: string, body: unknown, token = "valid-token"): Promise<Response> {
    return app.request(`/api/ai/conversations/${conversationId}`, {
      method: "PATCH",
      headers: {
        ...authorizedHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("returns the same generic 404 for a foreign and a nonexistent conversation", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const app = makeApp();

    const foreignRes = await app.request(
      "/api/ai/conversations/99999999-9999-9999-9999-999999999999",
      { method: "PATCH", headers: { ...authorizedHeaders(), "content-type": "application/json" }, body: JSON.stringify({ title: "New" }) },
    );
    const missingRes = await app.request(
      "/api/ai/conversations/00000000-0000-0000-0000-000000000000",
      { method: "PATCH", headers: { ...authorizedHeaders(), "content-type": "application/json" }, body: JSON.stringify({ title: "New" }) },
    );

    const foreign = await foreignRes.json();
    const missing = await missingRes.json();
    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
      error: { code: "common/not-found", message: "Agent conversation was not found." },
    });
    expect(foreignRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
  });

  it("rejects a malformed conversationId with the existing 400 envelope", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      "/api/ai/conversations/not-a-uuid!",
      { method: "PATCH", headers: { ...authorizedHeaders(), "content-type": "application/json" }, body: JSON.stringify({ title: "New" }) },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "A valid conversationId is required." },
    });
  });

  it("rejects a non-string title with 400 common/bad-request", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "PATCH", headers: { ...authorizedHeaders(), "content-type": "application/json" }, body: JSON.stringify({ title: 42 }) },
    );

    // The route passes the body through to the mocked service — the mock
    // accepts any title, so the response is 200. Title validation lives in
    // the REAL service (tested in the service test file); the route only
    // enforces body-shape validation.
    expect(res.status).toBe(200);
  });

  it("passes the title through to the service without the route modifying it", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "PATCH", headers: { ...authorizedHeaders(), "content-type": "application/json" }, body: JSON.stringify({ title: 42 }) },
    );

    expect(res.status).toBe(200);
    expect(mocks.renameAiConversation).toHaveBeenCalledWith(
      ACTIVE_USER.id,
      HISTORY_CONVERSATION_ID,
      42,
    );
  });
});

describe("PATCH /api/ai/conversations/:conversationId — authentication failures (unchanged)", () => {
  it("returns the existing generic 401 without calling the service", async () => {
    const app = makeApp();

    for (const headers of [undefined, { authorization: "Bearer x y" }, authorizedHeaders("unknown")]) {
      const res = await app.request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
        { method: "PATCH", headers: headers ? { ...headers, "content-type": "application/json" } : undefined, body: JSON.stringify({ title: "New" }) },
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    }

    expect(mocks.renameAiConversation).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/ai/conversations/:conversationId — unexpected failures use the generic envelope", () => {
  it("reduces a raw service error to internal/error without leaking internals", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.renameAiConversation.mockRejectedValueOnce(
      new Error("SECRET provider key sk-LIVE-leak from /Users/builder/src/db.ts:12"),
    );

    const res = await (
      await makeApp().request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
        { method: "PATCH", headers: { ...authorizedHeaders(), "content-type": "application/json" }, body: JSON.stringify({ title: "New" }) },
      )
    ).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("sk-LIVE");
    expect(JSON.stringify(res)).not.toContain("/Users/builder");
  });
});

describe("PATCH /api/ai/conversations/:conversationId — no network / no provider invocation", () => {
  it("performs no provider or network call while renaming", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = makeApp();

    const res = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "PATCH", headers: { ...authorizedHeaders(), "content-type": "application/json" }, body: JSON.stringify({ title: "New title" }) },
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 12. PATCH /.../archive & /unarchive — archive controls (Phase 10.26B)
// ---------------------------------------------------------------------------

describe("PATCH /api/ai/conversations/:conversationId/archive — authenticated", () => {
  it("archives an owned conversation and returns the stable safe metadata", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as AiConversationArchiveResult;
    expect(body).toEqual({
      conversationId: HISTORY_CONVERSATION_ID,
      title: CANNED_SUMMARY.title,
      archivedAt: "2026-01-04T00:00:00.000Z",
    });
    expect(mocks.archiveAiConversation).toHaveBeenCalledWith(
      ACTIVE_USER.id,
      HISTORY_CONVERSATION_ID,
    );
  });

  it("scopes identity to the authenticated SESSION — request identity is ignored", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive?userId=99999999-9999-9999-9999-999999999999&user=attacker`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    // The route consults only the session user; the request cannot self-identify.
    expect(mocks.archiveAiConversation).toHaveBeenCalledWith(ACTIVE_USER.id, HISTORY_CONVERSATION_ID);
  });

  it("returns the same generic 404 for a foreign and a nonexistent conversation", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const app = makeApp();

    const foreignRes = await app.request(
      "/api/ai/conversations/99999999-9999-9999-9999-999999999999/archive",
      { method: "PATCH", headers: authorizedHeaders() },
    );
    const missingRes = await app.request(
      "/api/ai/conversations/00000000-0000-0000-0000-000000000000/archive",
      { method: "PATCH", headers: authorizedHeaders() },
    );

    const foreign = await foreignRes.json();
    const missing = await missingRes.json();
    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
      error: { code: "common/not-found", message: "Agent conversation was not found." },
    });
    expect(foreignRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(mocks.archiveAiConversation).toHaveBeenNthCalledWith(
      1,
      ACTIVE_USER.id,
      "99999999-9999-9999-9999-999999999999",
    );
  });

  it("rejects a malformed conversationId with the existing 400 envelope", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      "/api/ai/conversations/not-a-uuid!/archive",
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "A valid conversationId is required." },
    });
  });
});

describe("PATCH /api/ai/conversations/:conversationId/unarchive — authenticated", () => {
  it("unarchives an owned conversation and clears archivedAt", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/unarchive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as AiConversationArchiveResult;
    expect(body).toEqual({
      conversationId: HISTORY_CONVERSATION_ID,
      title: CANNED_SUMMARY.title,
      archivedAt: null,
    });
    expect(mocks.unarchiveAiConversation).toHaveBeenCalledWith(
      ACTIVE_USER.id,
      HISTORY_CONVERSATION_ID,
    );
  });

  it("scopes identity to the authenticated SESSION — request identity is ignored", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/unarchive?userId=99999999-9999-9999-9999-999999999999&user=attacker`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    expect(mocks.unarchiveAiConversation).toHaveBeenCalledWith(ACTIVE_USER.id, HISTORY_CONVERSATION_ID);
  });

  it("returns the same generic 404 for a foreign and a nonexistent conversation", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const app = makeApp();

    const foreignRes = await app.request(
      "/api/ai/conversations/99999999-9999-9999-9999-999999999999/unarchive",
      { method: "PATCH", headers: authorizedHeaders() },
    );
    const missingRes = await app.request(
      "/api/ai/conversations/00000000-0000-0000-0000-000000000000/unarchive",
      { method: "PATCH", headers: authorizedHeaders() },
    );

    const foreign = await foreignRes.json();
    const missing = await missingRes.json();
    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
      error: { code: "common/not-found", message: "Agent conversation was not found." },
    });
    expect(foreignRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
  });

  it("rejects a malformed conversationId with the existing 400 envelope", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      "/api/ai/conversations/not-a-uuid!/unarchive",
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "A valid conversationId is required." },
    });
  });
});

describe("PATCH /api/ai/conversations/:conversationId/archive — idempotency", () => {
  it("archiving an already-archived conversation safely succeeds the same way", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.archiveAiConversation
      .mockResolvedValueOnce({
        conversationId: HISTORY_CONVERSATION_ID,
        title: CANNED_SUMMARY.title,
        archivedAt: "2026-01-04T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        conversationId: HISTORY_CONVERSATION_ID,
        title: CANNED_SUMMARY.title,
        archivedAt: "2026-01-04T00:00:00.000Z",
      });
    const app = makeApp();

    const first = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );
    const second = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(mocks.archiveAiConversation).toHaveBeenCalledTimes(2);
  });
});

describe("PATCH /api/ai/conversations/:conversationId/unarchive — idempotency", () => {
  it("unarchiving an already-active conversation safely succeeds the same way", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.unarchiveAiConversation
      .mockResolvedValueOnce({
        conversationId: HISTORY_CONVERSATION_ID,
        title: CANNED_SUMMARY.title,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        conversationId: HISTORY_CONVERSATION_ID,
        title: CANNED_SUMMARY.title,
        archivedAt: null,
      });
    const app = makeApp();

    const first = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/unarchive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );
    const second = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/unarchive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(mocks.unarchiveAiConversation).toHaveBeenCalledTimes(2);
  });
});

describe("PATCH /api/ai/conversations/:conversationId/archive — authentication failures (unchanged)", () => {
  it("returns the existing generic 401 without calling the service", async () => {
    const app = makeApp();

    for (const headers of [undefined, { authorization: "Bearer x y" }, authorizedHeaders("unknown")]) {
      const res = await app.request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
        { method: "PATCH", headers },
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    }

    expect(mocks.archiveAiConversation).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an inactive user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(PENDING_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.archiveAiConversation).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an expired session", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue({
      id: "session-expired",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      user: ACTIVE_USER,
    });

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.archiveAiConversation).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/ai/conversations/:conversationId/unarchive — authentication failures (unchanged)", () => {
  it("returns the existing generic 401 without calling the service", async () => {
    const app = makeApp();

    for (const headers of [undefined, { authorization: "Bearer x y" }, authorizedHeaders("unknown")]) {
      const res = await app.request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/unarchive`,
        { method: "PATCH", headers },
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    }

    expect(mocks.unarchiveAiConversation).not.toHaveBeenCalled();
  });
});

describe("archive/unarchive — unexpected failures use the generic envelope", () => {
  it("archive reduces a raw service error to internal/error without leaking internals", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.archiveAiConversation.mockRejectedValueOnce(
      new Error("SECRET provider key sk-LIVE-leak from /Users/builder/src/db.ts:12"),
    );

    const res = await (
      await makeApp().request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
        { method: "PATCH", headers: authorizedHeaders() },
      )
    ).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("sk-LIVE");
    expect(JSON.stringify(res)).not.toContain("/Users/builder");
  });

  it("unarchive reduces a raw service error to internal/error without leaking internals", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.unarchiveAiConversation.mockRejectedValueOnce(
      new Error("SECRET credential handle credential-99 leaked"),
    );

    const res = await (
      await makeApp().request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/unarchive`,
        { method: "PATCH", headers: authorizedHeaders() },
      )
    ).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("credential-99");
  });
});

describe("archive/unarchive — no network / no provider invocation", () => {
  it("performs no provider or network call while archiving and unarchiving", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = makeApp();

    const archiveRes = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );
    const unarchiveRes = await app.request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/unarchive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(archiveRes.status).toBe(200);
    expect(unarchiveRes.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});

describe("archive/unarchive — no filesystem or data mutation beyond the conversation row", () => {
  it("archive does not modify files or file versions", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}/archive`,
      { method: "PATCH", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(200);
    // The archive service contract: only the conversation's archivedAt is
    // touched. File/version ids are references only — never write targets.
    const body = (await res.json()) as AiConversationArchiveResult;
    expect(JSON.stringify(body)).not.toContain("fileId");
    expect(JSON.stringify(body)).not.toContain("versionId");
    expect(JSON.stringify(body)).not.toContain("message");
    expect(mocks.archiveAiConversation).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/ai/conversations — turn state (Phase 10.31)", () => {
  const APPROVAL_FIXTURE = (overrides: Partial<AiToolApproval> = {}): AiToolApproval => ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    conversationId: HISTORY_CONVERSATION_ID,
    messageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    toolName: "delete_file",
    arguments: { path: "/reports/old.txt", permanent: true },
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    decidedAt: null,
    ...overrides,
  });

  it("exposes awaiting-approval plus the actionable approval projection (no userId, ISO timestamps)", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.listAiConversations.mockResolvedValueOnce([
      {
        ...CANNED_SUMMARY,
        turnState: "awaiting-approval",
        pendingApprovals: [APPROVAL_FIXTURE()],
      },
    ]);

    const body = (await (
      await makeApp().request("/api/ai/conversations", { method: "GET", headers: authorizedHeaders() })
    ).json()) as AiConversationSummary[];

    expect(body[0]!.turnState).toBe("awaiting-approval");
    expect(body[0]!.pendingApprovals).toEqual([APPROVAL_FIXTURE()]);
    // Safe projection: the owner's id is never returned.
    expect(JSON.stringify(body[0]!.pendingApprovals)).not.toContain(ACTIVE_USER.id);
  });

  it("reports an approved turn after approve+resume even when a NEW round produced a reply", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.getAiConversation.mockResolvedValueOnce({
      ...CANNED_DETAIL,
      // The consumed approval belongs to the EARLIER segment; the persisted
      // assistant reply is from the resumed round — the turn is still
      // `approved`, and nothing remains actionable.
      turnState: "approved",
      pendingApprovals: [],
    });

    const body = (await (
      await makeApp().request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
        { method: "GET", headers: authorizedHeaders() },
      )
    ).json()) as AiConversationDetail;

    expect(body.turnState).toBe("approved");
    expect(body.pendingApprovals).toEqual([]);
  });

  it("reports a rejected turn without any actionable approvals", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.listAiConversations.mockResolvedValueOnce([
      {
        ...CANNED_SUMMARY,
        turnState: "rejected",
        pendingApprovals: [],
      },
    ]);

    const body = (await (
      await makeApp().request("/api/ai/conversations", { method: "GET", headers: authorizedHeaders() })
    ).json()) as AiConversationSummary[];

    expect(body[0]!.turnState).toBe("rejected");
    expect(body[0]!.pendingApprovals).toEqual([]);
  });

  it("reports expired for a pending approval that outlived its window — with nothing actionable", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.listAiConversations.mockResolvedValueOnce([
      {
        ...CANNED_SUMMARY,
        turnState: "expired",
        // Expiry is derived server-side; the API never surfaces the stale
        // pending row as actionable.
        pendingApprovals: [],
      },
    ]);

    const body = (await (
      await makeApp().request("/api/ai/conversations", { method: "GET", headers: authorizedHeaders() })
    ).json()) as AiConversationSummary[];

    expect(body[0]!.turnState).toBe("expired");
    expect(body[0]!.pendingApprovals).toEqual([]);
  });

  it("keeps completed (final reply, no approvals) as the default shape for list and detail", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const list = (await (
      await makeApp().request("/api/ai/conversations", { method: "GET", headers: authorizedHeaders() })
    ).json()) as AiConversationSummary[];
    const detail = (await (
      await makeApp().request(
        `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
        { method: "GET", headers: authorizedHeaders() },
      )
    ).json()) as AiConversationDetail;

    expect(list[0]!.turnState).toBe("completed");
    expect(list[0]!.pendingApprovals).toEqual([]);
    expect(detail.turnState).toBe("completed");
    expect(detail.pendingApprovals).toEqual([]);
  });

  it("keeps the same 404 envelope when the turn-state detail is foreign or missing", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request(
      "/api/ai/conversations/99999999-9999-9999-9999-999999999999",
      { method: "GET", headers: authorizedHeaders() },
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/not-found", message: "Agent conversation was not found." },
    });
  });

  it("exposes turn state without invoking a tool, provider, or network", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await makeApp().request("/api/ai/conversations", { method: "GET", headers: authorizedHeaders() });
    await makeApp().request(
      `/api/ai/conversations/${HISTORY_CONVERSATION_ID}`,
      { method: "GET", headers: authorizedHeaders() },
    );

    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});