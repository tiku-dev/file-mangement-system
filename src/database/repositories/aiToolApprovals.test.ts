/**
 * AI tool-approval repository tests (Phase 10.28B).
 *
 * The Prisma client is mocked (`../client.js` → `getDatabase`) with an
 * in-memory fake of the `ai_tool_approvals` delegate, so the repository runs
 * without a database. Tests cover:
 *
 *   1. createToolApproval persisting a NONE pending row with ownership and
 *      the injected timestamps.
 *   2. Duplicate detection: one pending approval per (messageId, toolName).
 *   3. getToolApproval ownership (foreign user is indistinguishable from
 *      "missing").
 *   4. resolveToolApproval approve/reject, already-resolved rejection, and
 *      expiry enforcement (pending past `expiresAt` is swept to `expired`
 *      before failing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ToolApprovalAlreadyResolvedError,
  ToolApprovalDecision,
  ToolApprovalDuplicateError,
  ToolApprovalExpiredError,
  ToolApprovalNotFoundError,
  ToolApprovalStatus,
  createToolApproval,
  getToolApproval,
  listToolApprovalsForConversations,
  resolveToolApproval,
} from "./aiToolApprovals.js";

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

function createFakeDb() {
  const approvals: AnyRecord[] = [];
  let seq = 0;

  function matches(row: AnyRecord, where?: AnyRecord): boolean {
    if (where === undefined) return true;
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  const delegates = {
    aiToolApproval: {
      create: vi.fn(async ({ data }: { data: AnyRecord }) => {
        seq += 1;
        const row = { id: `approval-${seq}`, ...data };
        approvals.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where = {} }: { where?: AnyRecord }) => {
        const row = approvals.find((a) => matches(a, where));
        return row ?? null;
      }),
      findMany: vi.fn(
        async ({
          where = {},
          orderBy,
        }: {
          where?: AnyRecord;
          orderBy?: unknown;
        }): Promise<AnyRecord[]> => {
          const predicate = (row: AnyRecord): boolean =>
            Object.entries(where).every(([key, value]) => {
              if (value !== null && typeof value === "object" && "in" in value) {
                return Array.isArray(value.in) && value.in.includes(row[key]);
              }
              return row[key] === value;
            });
          let rows = approvals.filter(predicate);
          if (orderBy !== undefined) {
            const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
            rows = [...rows].sort((a, b) => {
              for (const clause of clauses) {
                for (const [field, direction] of Object.entries(clause as AnyRecord)) {
                  const av = a[field] instanceof Date ? (a[field] as Date).getTime() : String(a[field]);
                  const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : String(b[field]);
                  if (av < bv) return direction === "asc" ? -1 : 1;
                  if (av > bv) return direction === "asc" ? 1 : -1;
                }
              }
              return 0;
            });
          }
          return rows;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: AnyRecord }) => {
        const index = approvals.findIndex((a) => a.id === where.id);
        if (index === -1) throw new Error("Approval not found (fake).");
        approvals[index] = { ...approvals[index], ...data };
        return approvals[index];
      }),
    },
    $transaction: vi.fn(async (fn: (tx: typeof delegates) => Promise<unknown>) => {
      return await fn(delegates);
    }),
  };
  return { delegates, approvals };
}

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONVERSATION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MESSAGE = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const NOW = new Date("2026-09-09T10:00:00.000Z");
const EXPIRES = new Date("2026-09-09T11:00:00.000Z");
const EXPIRED = new Date("2026-09-09T12:00:00.000Z");

function createArgs() {
  return {
    userId: ALICE,
    conversationId: CONVERSATION,
    messageId: MESSAGE,
    toolName: "delete_file",
    arguments: { path: "/reports/old.txt" },
    expiresAt: EXPIRES,
    now: NOW,
  };
}

describe("aiToolApprovals repository", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    db = createFakeDb();
    mocks.getDatabase.mockReturnValue(db.delegates);
  });

  describe("createToolApproval", () => {
    it("persists a pending approval with ownership and injected timestamps", async () => {
      const created = await createToolApproval(createArgs());

      expect(created.userId).toBe(ALICE);
      expect(created.conversationId).toBe(CONVERSATION);
      expect(created.messageId).toBe(MESSAGE);
      expect(created.toolName).toBe("delete_file");
      expect(created.status).toBe(ToolApprovalStatus.Pending);
      expect(created.decidedAt).toBeNull();
      expect(created.createdAt).toBe(NOW);
      expect(created.updatedAt).toBe(NOW);
      expect(created.expiresAt).toBe(EXPIRES);
      expect(db.approvals).toHaveLength(1);
      expect(db.approvals[0]).toMatchObject({
        userId: ALICE,
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        toolName: "delete_file",
        arguments: { path: "/reports/old.txt" },
        status: ToolApprovalStatus.Pending,
        decidedAt: null,
      });
    });

    it("rejects a second pending approval for the same message + tool", async () => {
      await createToolApproval(createArgs());

      await expect(
        createToolApproval({
          ...createArgs(),
          arguments: { path: "/reports/other.txt" },
        }),
      ).rejects.toBeInstanceOf(ToolApprovalDuplicateError);
      expect(db.approvals).toHaveLength(1);
    });

    it("allows a fresh approval once the previous one has been resolved", async () => {
      const created = await createToolApproval(createArgs());
      await resolveToolApproval(ALICE, created.id, ToolApprovalDecision.Reject, NOW);

      const second = await createToolApproval({ ...createArgs(), messageId: MESSAGE });
      expect(second.id).not.toBe(created.id);
      expect(second.status).toBe(ToolApprovalStatus.Pending);
      expect(db.approvals).toHaveLength(2);
    });
  });

  describe("getToolApproval", () => {
    it("returns the owned approval", async () => {
      const created = await createToolApproval(createArgs());

      const loaded = await getToolApproval(ALICE, created.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(created.id);
      expect(loaded!.arguments).toEqual({ path: "/reports/old.txt" });
    });

    it("returns null for an unknown approval id", async () => {
      expect(await getToolApproval(ALICE, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")).toBeNull();
    });

    it("returns null for another user's approval (indistinguishable from missing)", async () => {
      const created = await createToolApproval(createArgs());

      expect(await getToolApproval(BOB, created.id)).toBeNull();
    });
  });

  describe("resolveToolApproval", () => {
    it("approves a pending, in-window approval and stamps decidedAt", async () => {
      const created = await createToolApproval(createArgs());

      const resolved = await resolveToolApproval(ALICE, created.id, ToolApprovalDecision.Approve, NOW);

      expect(resolved.status).toBe(ToolApprovalStatus.Approved);
      expect(resolved.decidedAt).toBe(NOW);
      expect(resolved.updatedAt).toBe(NOW);
      expect(resolved.expiresAt).toBe(EXPIRES);
      expect(db.approvals[0]).toMatchObject({
        status: ToolApprovalStatus.Approved,
        decidedAt: NOW,
        updatedAt: NOW,
      });
    });

    it("rejects a pending, in-window approval", async () => {
      const created = await createToolApproval(createArgs());

      const resolved = await resolveToolApproval(ALICE, created.id, ToolApprovalDecision.Reject, NOW);

      expect(resolved.status).toBe(ToolApprovalStatus.Rejected);
      expect(resolved.decidedAt).toBe(NOW);
    });

    it("refuses to resolve an approval that is not pending (already approved)", async () => {
      const created = await createToolApproval(createArgs());
      await resolveToolApproval(ALICE, created.id, ToolApprovalDecision.Approve, NOW);

      await expect(
        resolveToolApproval(ALICE, created.id, ToolApprovalDecision.Reject, NOW),
      ).rejects.toBeInstanceOf(ToolApprovalAlreadyResolvedError);
      expect(db.approvals[0]!.status).toBe(ToolApprovalStatus.Approved);
    });

    it("throws NotFound for an unknown approval id", async () => {
      await expect(
        resolveToolApproval(ALICE, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", ToolApprovalDecision.Approve, NOW),
      ).rejects.toBeInstanceOf(ToolApprovalNotFoundError);
    });

    it("throws NotFound for another user's approval", async () => {
      const created = await createToolApproval(createArgs());

      await expect(
        resolveToolApproval(BOB, created.id, ToolApprovalDecision.Approve, NOW),
      ).rejects.toBeInstanceOf(ToolApprovalNotFoundError);
    });

    it("sweeps an expired pending approval to 'expired' and refuses to approve it", async () => {
      const created = await createToolApproval(createArgs());

      await expect(
        resolveToolApproval(ALICE, created.id, ToolApprovalDecision.Approve, EXPIRED),
      ).rejects.toBeInstanceOf(ToolApprovalExpiredError);
      expect(db.approvals[0]).toMatchObject({
        status: ToolApprovalStatus.Expired,
        decidedAt: EXPIRED,
      });
    });

    it("refuses to approve exactly at the expiry instant", async () => {
      const created = await createToolApproval(createArgs());

      await expect(
        resolveToolApproval(ALICE, created.id, ToolApprovalDecision.Approve, EXPIRES),
      ).rejects.toBeInstanceOf(ToolApprovalExpiredError);
      expect(db.approvals[0]!.status).toBe(ToolApprovalStatus.Expired);
    });
  });

  describe("listToolApprovalsForConversations (Phase 10.31)", () => {
    it("returns all OWNED approvals across the conversations, all states, oldest-first", async () => {
      const first = await createToolApproval(createArgs());
      const other = await createToolApproval({
        ...createArgs(),
        conversationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        messageId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        now: new Date("2026-09-09T10:03:00.000Z"),
      });
      const second = await createToolApproval({
        ...createArgs(),
        messageId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        toolName: "write_file",
        arguments: {},
        now: new Date("2026-09-09T10:05:00.000Z"),
      });
      await resolveToolApproval(
        ALICE,
        first.id,
        ToolApprovalDecision.Approve,
        new Date("2026-09-09T10:07:00.000Z"),
      );
      // A foreign approval for Bob in the SAME conversation must never leak.
      const foreign = await createToolApproval({
        ...createArgs(),
        userId: BOB,
        now: new Date("2026-09-09T09:00:00.000Z"),
      });

      const rows = await listToolApprovalsForConversations(ALICE, [
        CONVERSATION,
        other.conversationId,
      ]);

      expect(rows.map((r) => r.id)).not.toContain(foreign.id);
      expect(rows.every((r) => r.userId === ALICE)).toBe(true);
      // All states are returned (approved + pending), newest decision included.
      expect(rows.map((r) => r.status)).toEqual([
        ToolApprovalStatus.Approved,
        ToolApprovalStatus.Pending,
        ToolApprovalStatus.Pending,
      ]);
      // Oldest-first, deterministic.
      expect(rows.map((r) => r.createdAt.getTime())).toEqual(
        [first.createdAt, other.createdAt, second.createdAt].map((d) => d.getTime()),
      );
    });

    it("returns [] for an empty conversation list without touching the database", async () => {
      await expect(listToolApprovalsForConversations(ALICE, [])).resolves.toEqual([]);
      expect(mocks.getDatabase).not.toHaveBeenCalled();
    });
  });
});