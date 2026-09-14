/**
 * Generic AI tool-approval repository (Phase 10.28B) — the ONLY place
 * `ai_tool_approvals` persistence touches Prisma.
 *
 * Boundary rules (database/README): no HTTP semantics, no Hono deps, no
 * filesystem access, no provider calls, no network. The repository persists
 * the Phase 10.28 tool-approval contract (SCHEMA.md §6.8) under an
 * authenticated user's ownership. Ownership is enforced on every load and
 * modify: an `approvalId` that is not owned by `userId` is indistinguishable
 * from one that does not exist (returns `null` / throws
 * `ToolApprovalNotFoundError`).
 *
 * This layer stores ONLY an approval record's validated tool `arguments`
 * (the identifying input of the proposed operation). It never stores raw
 * file contents, provider responses, model output, or resolved filesystem
 * state; it never executes anything and never invokes the tool registry.
 *
 * State machine (SCHEMA.md §6.8): `pending` → `approved` | `rejected` |
 * `expired`. `expired` is reachable only from `pending` once `expires_at`
 * has passed without a decision; every terminal decision stamps
 * `decided_at`. Rows are transient conversation state: the schema cascades
 * them away with their conversation/message (unlike `ai_actions`, §6.7).
 */
import { getDatabase } from "../client.js";
import type { Prisma } from "../generated/prisma/client.js";

// ---------------------------------------------------------------------------
// Status / decision constants
// ---------------------------------------------------------------------------

/** Closed approval-state domain (SCHEMA.md §6.8; DB-enforced CHECK). */
export const ToolApprovalStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  Expired: "expired",
} as const;

export type ToolApprovalStatus = (typeof ToolApprovalStatus)[keyof typeof ToolApprovalStatus];

/** The only decisions the contract allows — approve or reject. */
export const ToolApprovalDecision = {
  Approve: "approved",
  Reject: "rejected",
} as const;

export type ToolApprovalDecision = (typeof ToolApprovalDecision)[keyof typeof ToolApprovalDecision];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when an approval id is unknown OR belongs to another user
 *  (both are deliberately indistinguishable). */
export class ToolApprovalNotFoundError extends Error {
  readonly code = "tool-approval/not-found-or-not-owned";
  constructor() {
    super("Tool approval not found for this user.");
    this.name = "ToolApprovalNotFoundError";
  }
}

/** Thrown when a pending approval already exists for the same message + tool. */
export class ToolApprovalDuplicateError extends Error {
  readonly code = "tool-approval/duplicate-pending";
  readonly messageId: string;
  readonly toolName: string;
  constructor(messageId: string, toolName: string) {
    super(
      `A pending tool approval already exists for tool "${toolName}" in message "${messageId}".`,
    );
    this.name = "ToolApprovalDuplicateError";
    this.messageId = messageId;
    this.toolName = toolName;
  }
}

/** Thrown when an approval's window elapsed before a decision was reached. */
export class ToolApprovalExpiredError extends Error {
  readonly code = "tool-approval/expired";
  constructor() {
    super("This tool approval has expired.");
    this.name = "ToolApprovalExpiredError";
  }
}

/** Thrown when resolving an approval that is not still `pending`. */
export class ToolApprovalAlreadyResolvedError extends Error {
  readonly code = "tool-approval/already-resolved";
  readonly status: ToolApprovalStatus;
  constructor(status: ToolApprovalStatus) {
    super(`This tool approval is already ${status}.`);
    this.name = "ToolApprovalAlreadyResolvedError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An `ai_tool_approvals` row projected into the app layer. */
export interface ToolApprovalRecord {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  /** Validated tool arguments that identify the proposed operation. */
  arguments: unknown;
  status: ToolApprovalStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
}

/** Input for creating a NEW pending approval. */
export interface CreateToolApprovalInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** Owning AI conversation (must already exist and belong to `userId`). */
  conversationId: string;
  /** The persisted message/turn that produced the tool request. */
  messageId: string;
  /** A REGISTERED tool name (validated by the contract, not the repo). */
  toolName: string;
  /** Validated tool arguments identifying the proposed operation. */
  arguments: unknown;
  /** Approval window bound; after this instant a pending row is expired. */
  expiresAt: Date;
  /** Authoritative "now" for timestamps + expiry checks (injectable). */
  now: Date;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function toRecord(row: {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  arguments: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
}): ToolApprovalRecord {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    toolName: row.toolName,
    arguments: row.arguments,
    status: row.status as ToolApprovalStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a NEW pending approval for a user-owned conversation/message.
 * One pending approval per (messageId, toolName): a second pending request
 * for the same tool in the same message is a duplicate and is rejected before
 * anything is written. Ownership is structural (`userId` on the row, D3) —
 * there is no cross-user read path.
 *
 * @throws `ToolApprovalDuplicateError` when a pending approval already exists
 *         for the same message + tool.
 */
export async function createToolApproval(
  input: CreateToolApprovalInput,
): Promise<ToolApprovalRecord> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const existing = await tx.aiToolApproval.findFirst({
      where: {
        messageId: input.messageId,
        toolName: input.toolName,
        status: ToolApprovalStatus.Pending,
      },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ToolApprovalDuplicateError(input.messageId, input.toolName);
    }
    const created = await tx.aiToolApproval.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        toolName: input.toolName,
        arguments: asJson(input.arguments),
        status: ToolApprovalStatus.Pending,
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.expiresAt,
        decidedAt: null,
      },
    });
    return toRecord(created);
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load ONE approval OWNED by `userId`, or `null` when it does not exist for
 * `userId` (ownership enforced — a foreign approval is indistinguishable
 * from a missing one).
 */
export async function getToolApproval(
  userId: string,
  approvalId: string,
): Promise<ToolApprovalRecord | null> {
  const db = getDatabase();
  const row = await db.aiToolApproval.findFirst({
    where: { id: approvalId, userId },
  });
  return row === null ? null : toRecord(row);
}

/**
 * Load the ONE `pending` approval for a given message + tool owned by
 * `userId`, or `null` when none is pending. Used by the Phase 10.28C
 * invocation gate to make a duplicate tool-approval request IDEMPOTENT:
 * the second request surfaces the existing pending approval instead of
 * writing a second row (the repository's one-pending-per-(message, tool)
 * rule stays the enforcement backstop). Ownership is enforced by the
 * `userId` predicate.
 */
export async function getPendingToolApproval(
  userId: string,
  messageId: string,
  toolName: string,
): Promise<ToolApprovalRecord | null> {
  const db = getDatabase();
  const row = await db.aiToolApproval.findFirst({
    where: {
      userId,
      messageId,
      toolName,
      status: ToolApprovalStatus.Pending,
    },
  });
  return row === null ? null : toRecord(row);
}

/**
 * List the current user's PENDING tool approvals, oldest-first (the natural
 * decision order). Ownership is structural (`userId`); only `pending` rows
 * are returned. Ordered by `createdAt` so the longest-waiting request is
 * decided first. The existing partial `(user_id, expires_at) WHERE status =
 * 'pending'` index covers the filter.
 */
export async function listPendingToolApprovals(userId: string): Promise<ToolApprovalRecord[]> {
  const db = getDatabase();
  const rows = await db.aiToolApproval.findMany({
    where: { userId, status: ToolApprovalStatus.Pending },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRecord);
}

/**
 * List EVERY approval OWNED by `userId` across the given conversations
 * (Phase 10.31), in ALL states (`pending`/`approved`/`rejected`/`expired`),
 * oldest-first (`createdAt` asc, then stable id). Used by the conversation
 * history service to expose per-conversation turn state and actionable
 * pending approvals. Ownership is structural (`userId`); an empty
 * conversation list returns `[]` without touching the database.
 */
export async function listToolApprovalsForConversations(
  userId: string,
  conversationIds: readonly string[],
): Promise<ToolApprovalRecord[]> {
  if (conversationIds.length === 0) return [];
  const db = getDatabase();
  const rows = await db.aiToolApproval.findMany({
    where: {
      userId,
      conversationId: { in: [...conversationIds] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toRecord);
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * Resolve a pending approval with an explicit decision (`approved` |
 * `rejected`). Ownership is verified inside the same transaction as the
 * write. Only `pending` rows may be resolved; once a decision is recorded the
 * row is terminal.
 *
 * Expiry is enforced HERE, at the decision boundary: a `pending` row whose
 * `expires_at` has passed is first swept to `expired` (with `decided_at`
 * stamped) and then throws `ToolApprovalExpiredError` — an expired approval
 * can never be approved. `decided_at`/`updated_at` are stamped with `now`.
 *
 * @throws `ToolApprovalNotFoundError` when the approval does not exist for
 *         `userId` (indistinguishable from foreign ownership).
 * @throws `ToolApprovalAlreadyResolvedError` when the row is not `pending`.
 * @throws `ToolApprovalExpiredError` when the window elapsed; the row is
 *         transitioned to `expired` before throwing.
 */
export async function resolveToolApproval(
  userId: string,
  approvalId: string,
  decision: ToolApprovalDecision,
  now: Date,
): Promise<ToolApprovalRecord> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const owned = await tx.aiToolApproval.findFirst({
      where: { id: approvalId, userId },
      select: { id: true, status: true, expiresAt: true },
    });
    if (owned === null) throw new ToolApprovalNotFoundError();
    if (owned.status !== ToolApprovalStatus.Pending) {
      throw new ToolApprovalAlreadyResolvedError(owned.status as ToolApprovalStatus);
    }
    if (now.getTime() >= owned.expiresAt.getTime()) {
      await tx.aiToolApproval.update({
        where: { id: approvalId },
        data: {
          status: ToolApprovalStatus.Expired,
          decidedAt: now,
          updatedAt: now,
        },
      });
      throw new ToolApprovalExpiredError();
    }
    const updated = await tx.aiToolApproval.update({
      where: { id: approvalId },
      data: {
        status: decision,
        decidedAt: now,
        updatedAt: now,
      },
    });
    return toRecord(updated);
  });
}

// ---------------------------------------------------------------------------
// Consume (Phase 10.30)
// ---------------------------------------------------------------------------

/**
 * Consume an ALREADY-EXECUTED `approved` approval so it can never authorize a
 * second execution. Consumption backdates `expires_at` to `now`: the row
 * stays `approved` (the DB CHECK forbids a `consumed` state) but every later
 * executable guard (`assertToolApprovalExecutable`,
 * `isToolApprovalExecutable`) treats it as expired, so any replay fails
 * closed. Ownership is verified inside the same transaction as the write.
 *
 * @throws `ToolApprovalNotFoundError` when the approval does not exist for
 *         `userId` (indistinguishable from foreign ownership).
 * @throws `ToolApprovalAlreadyResolvedError` when the row is not `approved`
 *         (a pending/rejected/expired approval has nothing to consume).
 * @throws `ToolApprovalExpiredError` when the window already elapsed; the row
 *         is transitioned to `expired` before throwing.
 */
export async function consumeToolApproval(
  userId: string,
  approvalId: string,
  now: Date,
): Promise<ToolApprovalRecord> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const owned = await tx.aiToolApproval.findFirst({
      where: { id: approvalId, userId },
      select: { id: true, status: true, expiresAt: true },
    });
    if (owned === null) throw new ToolApprovalNotFoundError();
    if (owned.status !== ToolApprovalStatus.Approved) {
      throw new ToolApprovalAlreadyResolvedError(owned.status as ToolApprovalStatus);
    }
    if (now.getTime() >= owned.expiresAt.getTime()) {
      await tx.aiToolApproval.update({
        where: { id: approvalId },
        data: {
          status: ToolApprovalStatus.Expired,
          decidedAt: now,
          updatedAt: now,
        },
      });
      throw new ToolApprovalExpiredError();
    }
    const updated = await tx.aiToolApproval.update({
      where: { id: approvalId },
      data: {
        expiresAt: now,
        updatedAt: now,
      },
    });
    return toRecord(updated);
  });
}
