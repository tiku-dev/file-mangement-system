/**
 * AI conversation history service (Phase 10.23 + 10.24) — the safe, typed
 * surface that backs `GET /api/ai/conversations[/:conversationId]` and
 * `DELETE /api/ai/conversations/:conversationId`.
 *
 * This module is THIN and provider-independent: it calls the existing Phase
 * 10.7 repository (`agentConversations`) for ownership-scoped reads and
 * shapes ONLY. Identity is exclusively the authenticated session user passed
 * in by the route — never read from the request.
 *
 * Security / presentation rules:
 *
 *   - OWNERSHIP is enforced by the repository (`where: { userId }`); a
 *     foreign conversation is indistinguishable from a missing one and both
 *     collapse to the existing 404 `common/not-found` envelope here.
 *   - conversationId is validated through the SHARED UUID convention
 *     (`validateConversationId`) before any query; malformed ids get the
 *     existing 400 `common/bad-request` envelope.
 *   - RETURNED SHAPES are stable and explicit. Persisted message text is the
 *     transcript itself; structured tool data is projected SAFELY:
 *     tool-call intents keep `callId`/`toolName`/`input`; tool results keep
 *     `callId`, status, and any structured metadata (names, sizes, exact
 *     `fileId`/`versionId` REFERENCES), while every content-bearing field
 *     (`data`, `encoding`, `content`, `text`, `raw`, `body`, `payload`,
 *     `base64`, `snippet`, `line`, `lines`, …) is dropped at any depth — so
 *     RAW FILE CONTENTS could never be echoed even if a persisted result
 *     carried them. Failed results expose only the structured `code` +
 *     `category` (never the message, which can embed internals). `path`
 *     fields in persisted intents are the authenticated user's own
 *     conversational references and are kept as references only.
 *   - ORDERING is deterministic: conversations newest-first (by `updatedAt`
 *     desc), persisted messages chronological (by `createdAt` asc).
 *   - DELETION is owned-scoped and atomic (the repository's single
 *     `deleteMany` + the schema's ON DELETE CASCADE): foreign/missing and
 *     repeated deletions all collapse to 404; file/version references are
 *     never deletion targets; deleted contents are never returned.
 *   - Provider keys, credential handles, environment variables, provider
 *     internals, stack traces, and DB internals never enter these shapes.
 *   - NO NETWORK: this module performs no provider or filesystem calls.
 */
import { AppError } from "../core/errors.js";
import {
  AgentConversationNotFoundError,
  archiveAgentConversation,
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
  listConversationLastMessages,
  renameAgentConversation,
  unarchiveAgentConversation,
  type StoredConversation,
  type StoredMessageRecord,
} from "../database/repositories/agentConversations.js";
import {
  ToolApprovalStatus,
  listConversationToolApprovals,
  type AiToolApproval,
} from "./aiToolApprovals.js";
import { validateConversationId } from "./conversationId.js";

// ---------------------------------------------------------------------------
// Safe response types
// ---------------------------------------------------------------------------

/**
 * Turn-state derived from the conversation's approvals and last transcript
 * row (Phase 10.31):
 *
 *   - `awaiting-approval` — at least one approval with an UNEXPIRED window is
 *     still `pending`: the turn is blocked at a decision.
 *   - `approved` | `rejected` | `expired` — the state of the most recent
 *     approval decision (by `updatedAt`), including a `pending` row whose
 *     window has elapsed (`expired`). After approve+resume (10.30) the turn
 *     is `approved` even where the latest transcript row belongs to a NEW
 *     round.
 *   - `completed` — the last transcript row is an `is_final` reply and there
 *     is nothing pending.
 *   - `failed` — the turn ended without a final reply and nothing pending.
 */
export type AiTurnState =
  | "completed"
  | "awaiting-approval"
  | "approved"
  | "rejected"
  | "expired"
  | "failed";

/** The metadata-only core shared by the summary and detail shapes. */
export interface AiConversationSummaryBase {
  id: string;
  title: string | null;
  maxToolRounds: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One owned conversation, newest-first — metadata plus the derived turn state
 * and its actionable approvals (Phase 10.31).
 */
export interface AiConversationSummary extends AiConversationSummaryBase {
  /** Derived terminal/pending state of the conversation's last turn. */
  turnState: AiTurnState;
  /** Approvals still awaiting a decision (`pending`, unexpired), oldest-first. */
  pendingApprovals: readonly AiToolApproval[];
}

/** A persisted tool-call intent for one provider round. */
export interface AiHistoryToolCall {
  /** Correlates with `AiHistoryToolResult.callId`. */
  callId: string;
  /** Name of a REGISTERED tool. */
  toolName: string;
  /** The untrusted intent input as it was validated at execution time. */
  input: unknown;
}

/** Structured error attribution for a FAILED tool result (message excluded). */
export interface AiStoredToolError {
  code: string;
  category: string;
}

/**
 * Safe projection of one persisted tool result. Success keeps structured
 * metadata with content-bearing fields stripped (raw contents can never be
 * echoed). Failure keeps only the structured code/category.
 */
export type AiHistoryToolResult =
  | { ok: true; callId: string; data?: unknown }
  | { ok: false; callId: string; error: AiStoredToolError };

/** One persisted transcript message, in chronological order. */
export interface AiHistoryMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  isFinal: boolean;
  toolCalls?: readonly AiHistoryToolCall[];
  toolResults?: readonly AiHistoryToolResult[];
}

/** One owned conversation with its persisted transcript and turn state. */
export interface AiConversationDetail extends AiConversationSummaryBase {
  turnState: AiTurnState;
  pendingApprovals: readonly AiToolApproval[];
  messages: readonly AiHistoryMessage[];
}

// ---------------------------------------------------------------------------
// Safe projection of stored tool data
// ---------------------------------------------------------------------------

/**
 * Structured field names that can carry file/message contents, secrets, or
 * provider internals and are NEVER projected into the API response, at any
 * nesting depth. Kept deliberately permissive so a persisted result can
 * never be a content or secret vector — even if a malicious or future tool
 * result stored one.
 */
const CONTENT_BEARING_FIELDS: ReadonlySet<string> = new Set([
  "base64",
  "body",
  "content",
  "contents",
  "data",
  "encoding",
  "line",
  "lines",
  "payload",
  "raw",
  "snippet",
  "text",
  // Secrets / credentials / provider internals (defense in depth).
  "accessToken",
  "apiKey",
  "apikey",
  "authorization",
  "credentialId",
  "credentials",
  "env",
  "envFile",
  "envVar",
  "environment",
  "handle",
  "key",
  "password",
  "passwd",
  "providerConfig",
  "secret",
  "stack",
  "stackTrace",
  "token",
  "trace",
  "traced",
]);

/**
 * Deep-project a stored structured value to its SAFE representation: arrays
 * and scalars pass through; object values keep every key EXCEPT
 * content-bearing fields (recursively). Structured references (`fileId`,
 * `versionId`, names, sizes, timestamps) survive as references only.
 */
export function projectStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectStructuredValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (CONTENT_BEARING_FIELDS.has(key)) continue;
      out[key] = projectStructuredValue(child);
    }
    return out;
  }
  return value;
}

function isPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function toSafeToolResult(raw: unknown): AiHistoryToolResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, callId: "", error: { code: "history/malformed", category: "stored" } };
  }
  const record = raw as Record<string, unknown>;
  const callId = typeof record.callId === "string" ? record.callId : "";
  if (record.ok === false) {
    return {
      ok: false,
      callId,
      error: toSafeToolError(record.error),
    };
  }
  const data = projectStructuredValue(record.data);
  return {
    ok: true,
    callId,
    ...(isPopulated(data) ? { data } : {}),
  };
}

function toSafeToolError(raw: unknown): AiStoredToolError {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { code: "history/malformed", category: "stored" };
  }
  const record = raw as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : "history/malformed",
    category: typeof record.category === "string" ? record.category : "stored",
  };
}

function toSafeToolCall(raw: unknown): AiHistoryToolCall {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { callId: "", toolName: "unknown", input: {} };
  }
  const record = raw as Record<string, unknown>;
  return {
    callId: typeof record.id === "string" ? record.id : "",
    toolName: typeof record.toolName === "string" ? record.toolName : "unknown",
    input: projectStructuredValue(record.input ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toSummaryBase(conversation: StoredConversation): AiConversationSummaryBase {
  return {
    id: conversation.id,
    title: conversation.title,
    maxToolRounds: conversation.maxToolRounds,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

function toMessage(message: StoredMessageRecord): AiHistoryMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    isFinal: message.isFinal,
    ...(message.toolCalls !== undefined
      ? { toolCalls: (Array.isArray(message.toolCalls) ? message.toolCalls : []).map(toSafeToolCall) }
      : {}),
    ...(message.toolResults !== undefined
      ? {
          toolResults: (Array.isArray(message.toolResults) ? message.toolResults : []).map(
            toSafeToolResult,
          ),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Turn-state derivation (Phase 10.31)
// ---------------------------------------------------------------------------

/**
 * Approvals that still require a decision: `pending` AND inside their window
 * (`now < expiresAt`). A pending row that outlived its window is NOT
 * actionable — it is derived as `expired`, never as pending. Pure.
 */
export function actionablePendingApprovals(
  approvals: readonly AiToolApproval[],
  now: Date,
): AiToolApproval[] {
  return approvals.filter(
    (approval) =>
      approval.status === ToolApprovalStatus.Pending &&
      now.getTime() < new Date(approval.expiresAt).getTime(),
  );
}

/**
 * The effective rank of an approval: `pending` when the window has elapsed
 * still derives as `expired` (the only `pending` that is NOT actionable).
 */
function approvalRank(approval: AiToolApproval): string {
  return approval.status;
}

/**
 * Derive a conversation's turn state (Phase 10.31).
 *
 * The inputs are the conversation's LAST transcript row (`isFinalReply`) and
 * ALL of its approvals — deliberately not per-segment approvals, because after
 * approve+resume (10.30) the consumed approval's `messageId` belongs to the
 * EARLIER segment while the resumed round is a NEW message. Filtering by the
 * last user-message segment would misclassify a resumed turn as `completed`.
 *
 * Resolution order (pure, deterministic):
 *
 *   1. Any actionable (unexpired) pending approval → `awaiting-approval`;
 *   2. otherwise the approval with the most recent `updatedAt`:
 *      `approve` → `approved`, `reject` → `rejected`, else (pending + window
 *      elapsed) → `expired`;
 *   3. otherwise (no approvals at all): `completed` when the turn ended with
 *      an `is_final` reply, else `failed`.
 */
export function deriveConversationTurnState(
  isFinalReply: boolean,
  approvals: readonly AiToolApproval[],
  now: Date,
): AiTurnState {
  if (actionablePendingApprovals(approvals, now).length > 0) return "awaiting-approval";
  if (approvals.length > 0) {
    const mostRecent = [...approvals].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0];
    switch (approvalRank(mostRecent!)) {
      case ToolApprovalStatus.Approved:
        return "approved";
      case ToolApprovalStatus.Rejected:
        return "rejected";
      default:
        return "expired";
    }
  }
  return isFinalReply ? "completed" : "failed";
}

/** Index approvals by conversationId for batch enrichment. Pure. */
export function groupApprovalsByConversation(
  approvals: readonly AiToolApproval[],
): ReadonlyMap<string, readonly AiToolApproval[]> {
  const grouped = new Map<string, AiToolApproval[]>();
  for (const approval of approvals) {
    const list = grouped.get(approval.conversationId);
    if (list === undefined) {
      grouped.set(approval.conversationId, [approval]);
    } else {
      list.push(approval);
    }
  }
  return grouped;
}

/**
 * Attach `turnState` + `pendingApprovals` to a summary/detail base, given its
 * approvals and whether its last transcript row is an assistant `is_final`
 * reply. Pure.
 */
export function enrichTurnState<Base extends AiConversationSummaryBase>(
  base: Base,
  isFinalReply: boolean,
  approvals: readonly AiToolApproval[],
  now: Date,
): Base & {
  turnState: AiTurnState;
  pendingApprovals: readonly AiToolApproval[];
} {
  return {
    ...base,
    turnState: deriveConversationTurnState(isFinalReply, approvals, now),
    pendingApprovals: actionablePendingApprovals(approvals, now),
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * List the authenticated user's conversations, newest-first (deterministic:
 * `updatedAt` desc, then `createdAt` desc, then stable id). Empty history
 * returns a valid empty array.
 *
 * Optional Phase 10.27 `query` searches the user's OWNED non-archived
 * conversations by title (case-insensitive substring). The `query` is
 * trimmed; empty/whitespace-only input behaves exactly like no query. The
 * repository layer owns the `contains` filter — the service only normalizes
 * and validates the input. Search never touches message contents, tool
 * results, or file contents, and archived conversations stay excluded.
 *
 * @throws `AppError.badRequest` (400 `common/bad-request`) when `query` is a
 *         non-string or exceeds 255 characters after trimming (consistent
 *         with the title length limit).
 */
export async function listAiConversations(
  userId: string,
  query?: string,
): Promise<AiConversationSummary[]> {
  let titleQuery: string | undefined;
  if (query !== undefined) {
    if (typeof query !== "string") {
      throw AppError.badRequest("Search terms must be a string.");
    }
    const trimmed = query.trim();
    if (trimmed.length > 255) {
      throw AppError.badRequest("Search terms must be 255 characters or fewer.");
    }
    titleQuery = trimmed.length > 0 ? trimmed : undefined;
  }
  const conversations =
    titleQuery === undefined
      ? await listAgentConversations(userId)
      : await listAgentConversations(userId, titleQuery);
  const summaries = conversations.map((conversation) => toSummaryBase(conversation));
  if (summaries.length === 0) return [];
  const conversationIds = summaries.map((summary) => summary.id);
  const [approvals, lastMessages] = await Promise.all([
    listConversationToolApprovals(userId, conversationIds),
    listConversationLastMessages(userId, conversationIds),
  ]);
  const approvalsByConversation = groupApprovalsByConversation(approvals);
  const finalReplyByConversation = new Map<string, boolean>();
  for (const row of lastMessages) {
    finalReplyByConversation.set(row.conversationId, row.role === "assistant" && row.isFinal);
  }
  const now = new Date();
  return summaries.map((summary) =>
    enrichTurnState(
      summary,
      finalReplyByConversation.get(summary.id) ?? false,
      approvalsByConversation.get(summary.id) ?? [],
      now,
    ),
  );
}

/**
 * Retrieve ONE conversation owned by `userId` with its persisted messages in
 * chronological order. A foreign OR missing conversation is indistinguishable
 * and both produce the existing 404 `common/not-found` envelope.
 *
 * @throws `AppError.badRequest` on a malformed conversationId (400
 *         `common/bad-request`); `AppError.notFound` (404 `common/not-found`)
 *         when the conversation does not exist for `userId`.
 */
export async function getAiConversation(
  userId: string,
  conversationIdParam: string,
): Promise<AiConversationDetail> {
  const conversationId = validateConversationId(conversationIdParam);
  const detail = await getAgentConversation(userId, conversationId);
  if (detail === null) {
    throw AppError.notFound("Agent conversation");
  }
  const [approvals, lastMessages] = await Promise.all([
    listConversationToolApprovals(userId, [conversationId]),
    listConversationLastMessages(userId, [conversationId]),
  ]);
  const last = lastMessages[0];
  return enrichTurnState(
    {
      ...toSummaryBase(detail.conversation),
      messages: detail.messages.map(toMessage),
    },
    last !== undefined && last.role === "assistant" && last.isFinal,
    approvals,
    new Date(),
  );
}

// ---------------------------------------------------------------------------
// Delete (Phase 10.24)
// ---------------------------------------------------------------------------

/** Stable success response for `DELETE /api/ai/conversations/:conversationId`. */
export interface AiConversationDeletionResult {
  conversationId: string;
  deleted: true;
}

/**
 * Delete ONE conversation owned by `userId`, atomically. A foreign OR
 * missing conversation is indistinguishable and both produce the existing
 * 404 `common/not-found` envelope; the same applies to a second deletion of
 * an already-deleted conversation.
 *
 * This service NEVER returns the deleted conversation's contents and NEVER
 * touches file/version records — `fileId`/`versionId` are metadata
 * references, not deletion targets.
 *
 * @throws `AppError.badRequest` on a malformed conversationId (400
 *         `common/bad-request`); `AppError.notFound` (404 `common/not-found`)
 *         when the conversation does not exist for `userId`.
 */
export async function deleteAiConversation(
  userId: string,
  conversationIdParam: string,
): Promise<AiConversationDeletionResult> {
  const conversationId = validateConversationId(conversationIdParam);
  try {
    await deleteAgentConversation(userId, conversationId);
  } catch (error) {
    if (error instanceof AgentConversationNotFoundError) {
      throw AppError.notFound("Agent conversation");
    }
    // Unexpected repository/database failures propagate raw so the HTTP
    // layer's generic `internal/error` envelope hides the details.
    throw error;
  }
  return { conversationId, deleted: true };
}
// ---------------------------------------------------------------------------
// Rename (Phase 10.25)
// ---------------------------------------------------------------------------

/** Stable response for `PATCH /api/ai/conversations/:conversationId`. */
export interface AiConversationRenameResult {
  conversationId: string;
  title: string;
}

/**
 * Rename ONE conversation owned by `userId`. Ownership is enforced in the
 * repository (single `where: { userId, id }` update); the service validates
 * only the input (title) upstream and maps the database errors to the existing
 * stable envelopes downstream.
 *
 * A foreign OR missing conversation is indistinguishable: both collapse to
 * the existing 404 `common/not-found` envelope. A duplicate rename of an
 * already-renamed conversation succeeds silently (idempotent title write).
 *
 * Identity is the authenticated session user. No body-supplied identity is ever
 * accepted (the route strips unexpected body fields first).
 *
 * Returns the stable safe summary of the renamed conversation. No tool call
 * results, no message contents, no provider/credential info.
 *
 * @throws `AppError.badRequest` on a malformed conversationId (400),
 *         non-string title, empty/whitespace-only title, or overlong title
 *         (> 255 characters after trimming).
 * @throws `AppError.notFound` (404 `common/not-found`) when the conversation
 *         does not exist for `userId`.
 * @throws the generic `internal/error` worst-case envelope on unexpected
 *         repository/database failures (propagated raw so the HTTP layer's
 *         envelope hides the details).
 */
export async function renameAiConversation(
  userId: string,
  conversationIdParam: string,
  title: string,
): Promise<AiConversationRenameResult> {
  // --- input validation -----------------------------------------------------------------
  const conversationId = validateConversationId(conversationIdParam);

  if (typeof title !== "string") {
    throw AppError.badRequest("Title must be a string.");
  }

  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw AppError.badRequest("Title must not be empty.");
  }

  if (trimmed.length > 255) {
    throw AppError.badRequest(
      "Title must be 255 characters or fewer.",
    );
  }

  // --- rename -----------------------------------------------------------------------------------
  try {
    const renamed = await renameAgentConversation(userId, conversationId, trimmed);
    return {
      conversationId: renamed.id,
      title: renamed.title,
    };
  } catch (error) {
    if (error instanceof AgentConversationNotFoundError) {
      throw AppError.notFound("Agent conversation was not found.");
    }
    // Unexpected repository/database failures propagate raw so the HTTP
    // layer's generic `internal/error` envelope hides the details.
    throw error;
  }
}
// ---------------------------------------------------------------------------
// Archive / unarchive (Phase 10.26B)
// ---------------------------------------------------------------------------

/** Stable success response for `PATCH /api/ai/conversations/:conversationId/archive`. */
export interface AiConversationArchiveResult {
  conversationId: string;
  title: string | null;
  archivedAt: string | null;
}

/**
 * Archive ONE conversation owned by `userId` (Phase 10.26B): set its
 * `archivedAt` to the current timestamp. Idempotent — archiving an already
 * archived conversation succeeds silently.
 *
 * Ownership is enforced in the repository (a single ownership-scoped update);
 * a foreign OR missing conversation is indistinguishable and both collapse to
 * the existing 404 `common/not-found` envelope. Only the `archivedAt` (and
 * maintained `updatedAt`) changes — messages, tool calls/results, file/version
 * references, title, and ownership are never modified.
 *
 * Identity is exclusively the authenticated session user; the route never
 * accepts a body-supplied identity.
 *
 * Returns the stable safe metadata of the archived conversation (id, title,
 * `archivedAt`). No tool results, message contents, or provider/credential info.
 *
 * @throws `AppError.badRequest` (400 `common/bad-request`) on a malformed
 *         conversationId.
 * @throws `AppError.notFound` (404 `common/not-found`) when the conversation
 *         does not exist for `userId`.
 * @throws the generic `internal/error` worst-case envelope on unexpected
 *         repository/database failures (propagated raw).
 */
export async function archiveAiConversation(
  userId: string,
  conversationIdParam: string,
): Promise<AiConversationArchiveResult> {
  const conversationId = validateConversationId(conversationIdParam);
  try {
    const archived = await archiveAgentConversation(userId, conversationId, new Date());
    return {
      conversationId: archived.id,
      title: archived.title,
      archivedAt: archived.archivedAt === null ? null : archived.archivedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof AgentConversationNotFoundError) {
      throw AppError.notFound("Agent conversation was not found.");
    }
    throw error;
  }
}

/**
 * Unarchive ONE conversation owned by `userId` (Phase 10.26B): clear its
 * `archivedAt` back to `NULL`. Idempotent — unarchiving an already-active
 * conversation succeeds silently.
 *
 * Ownership is enforced in the repository; a foreign OR missing conversation
 * is indistinguishable and both collapse to the existing 404
 * `common/not-found` envelope. Only the `archivedAt` (and maintained
 * `updatedAt`) changes — no other state is modified.
 *
 * Identity is exclusively the authenticated session user.
 *
 * @throws `AppError.badRequest` (400 `common/bad-request`) on a malformed
 *         conversationId.
 * @throws `AppError.notFound` (404 `common/not-found`) when the conversation
 *         does not exist for `userId`.
 * @throws the generic `internal/error` worst-case envelope on unexpected
 *         repository/database failures (propagated raw).
 */
export async function unarchiveAiConversation(
  userId: string,
  conversationIdParam: string,
): Promise<AiConversationArchiveResult> {
  const conversationId = validateConversationId(conversationIdParam);
  try {
    const unarchived = await unarchiveAgentConversation(userId, conversationId, new Date());
    return {
      conversationId: unarchived.id,
      title: unarchived.title,
      archivedAt: unarchived.archivedAt === null ? null : unarchived.archivedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof AgentConversationNotFoundError) {
      throw AppError.notFound("Agent conversation was not found.");
    }
    throw error;
  }
}