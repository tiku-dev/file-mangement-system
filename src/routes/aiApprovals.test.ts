/**
 * Authenticated approval API route tests (Phase 10.28D).
 *
 * Drives the REAL `aiRoutes` approval endpoints (`GET /api/ai/approvals`,
 * `POST /api/ai/approvals/:approvalId/approve`, `POST /api/ai/approvals/:approvalId/reject`)
 * with the REAL `requireAuth` middleware and the real `onError` envelope. The
 * approval SERVICE is mocked with a small in-memory store keyed by approval id,
 * so ownership, state transitions, expiry, and idempotency are deterministic.
 *
 * Coverage:
 *
 *   1. Authentication: unauthenticated → generic 401 auth/unauthorized.
 *   2. Listing: authenticated user sees only their OWN pending approvals,
 *      oldest-first, projected to the safe representation (no userId, ISO
 *      timestamps); an empty queue → [].
 *   3. Approve / reject: 200 with the safe projection; idempotent repeat
 *      decision returns the terminal state.
 *   4. Malformed id → 400; missing/foreign → safe 404 (indistinguishable);
 *      expired → 400.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { onError } from "../core/http.js";
import { aiRoutes } from "./ai.js";
import { CONVERSATION_ID_PATTERN } from "../services/conversationId.js";
import {
  approveToolApproval,
  listPendingToolApprovals,
  rejectToolApproval,
  type ToolApprovalRecord,
} from "../services/aiToolApprovals.js";

const mocks = vi.hoisted(() => ({
  findSessionByTokenHash: vi.fn(),
  updateSessionLastUsedAt: vi.fn(),
  databaseNow: vi.fn(),
  listPendingToolApprovals: vi.fn(),
  approveToolApproval: vi.fn(),
  rejectToolApproval: vi.fn(),
  // The route's `mapApprovalError` branches on these classes — the mock must
  // provide the REAL classes so `instanceof` decides the shared envelope.
  ToolApprovalValidationError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ToolApprovalValidationError";
    }
  },
  ToolApprovalNotFoundError: class extends Error {
    constructor() {
      super("Tool approval not found for this user.");
      this.name = "ToolApprovalNotFoundError";
    }
  },
  ToolApprovalExpiredError: class extends Error {
    constructor() {
      super("This tool approval has expired.");
      this.name = "ToolApprovalExpiredError";
    }
  },
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

vi.mock("../services/aiToolApprovals.js", async (importOriginal) => {
  return {
    // Spread the REAL module so the route resolves the shared content-free
    // `toAiApproval` projection (Phase 10.31) while only the three service
    // entry points and the `instanceof`-matched error classes are stubbed.
    ...(await importOriginal<typeof import("../services/aiToolApprovals.js")>()),
    approveToolApproval: mocks.approveToolApproval,
    rejectToolApproval: mocks.rejectToolApproval,
    listPendingToolApprovals: mocks.listPendingToolApprovals,
    ToolApprovalValidationError: mocks.ToolApprovalValidationError,
    ToolApprovalNotFoundError: mocks.ToolApprovalNotFoundError,
    ToolApprovalExpiredError: mocks.ToolApprovalExpiredError,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};
const BOB = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob Example",
  status: "active",
};

const CONVERSATION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MESSAGE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const APPROVAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPROVAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPROVAL_EXPIRED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function sessionFor(user: {
  id: string;
  email: string;
  displayName: string;
  status: string;
}): unknown {
  return { id: "session-1", expiresAt: new Date("2099-01-01T00:00:00Z"), user };
}

function pendingRecord(
  id: string,
  userId: string,
  overrides: Partial<ToolApprovalRecord> = {},
): ToolApprovalRecord {
  return {
    id,
    userId,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    toolName: "delete_file",
    arguments: { path: "/reports/old.txt", permanent: true },
    status: "pending",
    createdAt: new Date("2026-09-09T10:00:00Z"),
    updatedAt: new Date("2026-09-09T10:00:00Z"),
    expiresAt: new Date("2026-09-09T11:00:00Z"),
    decidedAt: null,
    ...overrides,
  };
}

const store = new Map<string, ToolApprovalRecord>();

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  mocks.findSessionByTokenHash.mockReset();
  mocks.updateSessionLastUsedAt.mockResolvedValue(undefined);
  mocks.databaseNow.mockResolvedValue(new Date("2026-01-01T00:00:00Z"));

  store.set(APPROVAL_A, pendingRecord(APPROVAL_A, ALICE.id));
  store.set(APPROVAL_B, pendingRecord(APPROVAL_B, ALICE.id));
  store.set(APPROVAL_EXPIRED, {
    ...pendingRecord(APPROVAL_EXPIRED, ALICE.id),
    status: "expired" as const,
  });

  mocks.listPendingToolApprovals.mockImplementation(async (userId: string) => {
    return [...store.values()]
      .filter((r) => r.userId === userId && r.status === "pending")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  });

  mocks.approveToolApproval.mockImplementation(async (userId: string, approvalId: unknown) => {
    if (typeof approvalId !== "string" || !CONVERSATION_ID_PATTERN.test(approvalId)) {
      throw new mocks.ToolApprovalValidationError("A valid approvalId is required.");
    }
    const record = store.get(approvalId);
    if (record === undefined || record.userId !== userId) {
      throw new mocks.ToolApprovalNotFoundError();
    }
    if (record.status === "expired") {
      throw new mocks.ToolApprovalExpiredError();
    }
    if (record.status !== "pending") {
      return record;
    }
    const approved = {
      ...record,
      status: "approved" as const,
      decidedAt: new Date("2026-09-09T10:05:00Z"),
    };
    store.set(approvalId, approved);
    return approved;
  });

  mocks.rejectToolApproval.mockImplementation(async (userId: string, approvalId: unknown) => {
    if (typeof approvalId !== "string" || !CONVERSATION_ID_PATTERN.test(approvalId)) {
      throw new mocks.ToolApprovalValidationError("A valid approvalId is required.");
    }
    const record = store.get(approvalId);
    if (record === undefined || record.userId !== userId) {
      throw new mocks.ToolApprovalNotFoundError();
    }
    if (record.status === "expired") {
      throw new mocks.ToolApprovalExpiredError();
    }
    if (record.status !== "pending") {
      return record;
    }
    const rejected = {
      ...record,
      status: "rejected" as const,
      decidedAt: new Date("2026-09-09T10:05:00Z"),
    };
    store.set(approvalId, rejected);
    return rejected;
  });
});

function makeApp(): Hono {
  const app = new Hono();
  app.onError(onError);
  app.route("/api/ai", aiRoutes);
  return app;
}

function authorizedHeaders(token = "valid-token"): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function safeProjection(record: ToolApprovalRecord) {
  return {
    id: record.id,
    conversationId: record.conversationId,
    messageId: record.messageId,
    toolName: record.toolName,
    arguments: record.arguments,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    decidedAt: record.decidedAt === null ? null : record.decidedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. Authentication — every approval endpoint fails closed
// ---------------------------------------------------------------------------

describe("approval API — authentication", () => {
  it("GET /approvals → 401 auth/unauthorized when unauthenticated", async () => {
    const res = await makeApp().request("/api/ai/approvals", { headers: {} });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "auth/unauthorized" } });
  });

  it("POST /approvals/:id/approve → 401 when unauthenticated", async () => {
    const res = await makeApp().request(`/api/ai/approvals/${APPROVAL_A}/approve`, {
      method: "POST",
      headers: {},
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "auth/unauthorized" } });
  });

  it("POST /approvals/:id/reject → 401 when unauthenticated", async () => {
    const res = await makeApp().request(`/api/ai/approvals/${APPROVAL_A}/reject`, {
      method: "POST",
      headers: {},
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "auth/unauthorized" } });
  });
});

// ---------------------------------------------------------------------------
// 2. Listing — ownership-scoped, safe projection only
// ---------------------------------------------------------------------------

describe("GET /api/ai/approvals — listing", () => {
  it("returns only the caller's OWN pending approvals, oldest-first, as the safe projection", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const res = await makeApp().request("/api/ai/approvals", {
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<ReturnType<typeof safeProjection>>;
    expect(body).toHaveLength(2);
    // Oldest first (10:00 both — stable ordering from the store's sort).
    expect(body.map((r) => r.id)).toEqual([APPROVAL_A, APPROVAL_B]);
    for (const entry of body) {
      // Safe projection: no userId, ISO timestamps, pending status only.
      expect(Object.keys(entry).sort()).toEqual(
        [
          "arguments",
          "conversationId",
          "createdAt",
          "decidedAt",
          "expiresAt",
          "id",
          "messageId",
          "status",
          "toolName",
          "updatedAt",
        ].sort(),
      );
      expect(Object.keys(entry)).not.toContain("userId");
      expect(entry.status).toBe("pending");
    }
    expect(body[0]).toMatchObject({
      id: APPROVAL_A,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      toolName: "delete_file",
      arguments: { path: "/reports/old.txt", permanent: true },
    });
    expect(typeof body[0]!.createdAt).toBe("string");
    expect(body[0]!.expiresAt).toBe("2026-09-09T11:00:00.000Z");
    expect(body[0]!.decidedAt).toBeNull();
  });

  it("returns [] when the authenticated user has no pending approvals", async () => {
    // BOB owns nothing — the store only has Alice's rows.
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(BOB));

    const res = await makeApp().request("/api/ai/approvals", {
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("never lists an already-resolved (expired) approval", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const res = await makeApp().request("/api/ai/approvals", {
      headers: authorizedHeaders(),
    });

    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id)).not.toContain(APPROVAL_EXPIRED);
  });
});

// ---------------------------------------------------------------------------
// 3. Approve — terminal, idempotent, ownership-scoped
// ---------------------------------------------------------------------------

describe("POST /api/ai/approvals/:id/approve", () => {
  it("approves an owned pending approval → 200 safe projection, terminal state", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));
    expect(store.get(APPROVAL_A)?.status).toBe("pending");

    const res = await makeApp().request(`/api/ai/approvals/${APPROVAL_A}/approve`, {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof safeProjection>;
    expect(body).toMatchObject({ id: APPROVAL_A, status: "approved" });
    expect(body.decidedAt).toBe("2026-09-09T10:05:00.000Z");
    // Approving never executes / never lists a new pending row.
    expect(store.get(APPROVAL_A)?.status).toBe("approved");
  });

  it("is idempotent — a repeated approve returns the same terminal state", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const first = await makeApp().request(`/api/ai/approvals/${APPROVAL_A}/approve`, {
      method: "POST",
      headers: authorizedHeaders(),
    });
    const second = await makeApp().request(`/api/ai/approvals/${APPROVAL_A}/approve`, {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as ReturnType<typeof safeProjection>;
    const secondBody = (await second.json()) as ReturnType<typeof safeProjection>;
    expect(firstBody).toEqual(secondBody);
    expect(secondBody).toMatchObject({ status: "approved" });
  });

  it("rejects a FOREIGN (or missing) approval with a safe 404", async () => {
    // Alice's approval presented by Bob — indistinguishable from missing.
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(BOB));

    const res = await makeApp().request(`/api/ai/approvals/${APPROVAL_A}/approve`, {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("common/not-found");
    expect(JSON.stringify(body)).not.toContain(ALICE.id);
    expect(store.get(APPROVAL_A)?.status).toBe("pending");
  });

  it("returns 400 on a malformed approval id", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const res = await makeApp().request("/api/ai/approvals/not-a-uuid/approve", {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "common/bad-request" } });
  });

  it("returns 400 when the approval window has elapsed", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const res = await makeApp().request(`/api/ai/approvals/${APPROVAL_EXPIRED}/approve`, {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("common/bad-request");
    expect(body.error.message).toContain("expired");
  });
});

// ---------------------------------------------------------------------------
// 4. Reject — terminal, idempotent, ownership-scoped
// ---------------------------------------------------------------------------

describe("POST /api/ai/approvals/:id/reject", () => {
  it("rejects an owned pending approval → 200 safe projection, terminal state", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const res = await makeApp().request(`/api/ai/approvals/${APPROVAL_B}/reject`, {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof safeProjection>;
    expect(body).toMatchObject({ id: APPROVAL_B, status: "rejected" });
    expect(store.get(APPROVAL_B)?.status).toBe("rejected");
  });

  it("is idempotent — a repeated reject returns the same terminal state", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const first = await makeApp().request(`/api/ai/approvals/${APPROVAL_B}/reject`, {
      method: "POST",
      headers: authorizedHeaders(),
    });
    const second = await makeApp().request(`/api/ai/approvals/${APPROVAL_B}/reject`, {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as ReturnType<typeof safeProjection>;
    const secondBody = (await second.json()) as ReturnType<typeof safeProjection>;
    expect(firstBody).toEqual(secondBody);
    expect(secondBody).toMatchObject({ status: "rejected" });
  });

  it("rejects a FOREIGN (or missing) approval with a safe 404", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(BOB));

    const res = await makeApp().request(`/api/ai/approvals/${APPROVAL_A}/reject`, {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("common/not-found");
    expect(store.get(APPROVAL_A)?.status).toBe("pending");
  });

  it("returns 400 on a malformed approval id", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const res = await makeApp().request("/api/ai/approvals/not-a-uuid/reject", {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "common/bad-request" } });
  });

  it("returns 400 when the approval window has elapsed", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ALICE));

    const res = await makeApp().request(`/api/ai/approvals/${APPROVAL_EXPIRED}/reject`, {
      method: "POST",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "common/bad-request" } });
  });
});
