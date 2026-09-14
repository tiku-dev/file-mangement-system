/**
 * AI routes (Phase 10.21 + 10.22 + 10.23) — authenticated application-level
 * AI APIs.
 *
 * `GET  /api/ai/status`                     — safe provider capability status.
 * `POST /api/ai/instructions`               — submit one instruction to the agent runtime.
 * `GET  /api/ai/conversations`              — list the user's conversations, newest-first.
 *                                              Optional `?q=` searches the user's own
 *                                              non-archived conversations by title (case-
 *                                              insensitive substring; Phase 10.27).
 * `GET  /api/ai/conversations/:conversationId` — retrieve one owned conversation
 *                                              + its chronological transcript.
 * `DELETE /api/ai/conversations/:conversationId` — delete one owned conversation
 *                                              atomically (cascade transcript).
 * `GET    /api/ai/approvals`                              — list the authenticated user's pending tool approvals.
 * `POST   /api/ai/approvals/:approvalId/approve`          — approve one owned pending approval.
 * `POST   /api/ai/approvals/:approvalId/reject`           — reject one owned pending approval.
 *
 * Approval API (Phase 10.28D):
 *
 *   - All use the EXISTING per-route `requireAuth` middleware; unauthenticated
 *     requests receive the existing generic 401 `auth/unauthorized` envelope.
 *   - Identity comes EXCLUSIVELY from the authenticated session — never from
 *     the request body or path. The service ownership-scopes every operation,
 *     so a foreign or missing approval is indistinguishable and both produce
 *     the existing 404.
 *   - `GET /approvals` returns only the caller's OWN pending approvals (oldest
 *     first), projected to a safe representation: ids, tool name, validated
 *     arguments, status, timestamps, expiry, and decision timestamp. No
 *     secrets, credentials, raw file contents, or internal details ever leave
 *     the API.
 *   - Approve/reject are idempotent: a repeated decision returns the existing
 *     terminal state rather than erroring. An expired approval cannot be
 *     approved/rejected (400). Approving/rejecting never executes a tool —
 *     execution stays behind the existing approved-tool invocation path.
 *   - All use the EXISTING per-route `requireAuth` middleware; unauthenticated
 *     requests receive the existing generic 401 `auth/unauthorized` envelope.
 *   - This is application-level AI access, NOT an admin endpoint: every
 *     authenticated user gets the same safe capabilities. The request body /
 *     headers / path params / user-supplied identity are never trusted — only
 *     the authenticated session user is consulted. `/instructions` rejects
 *     any body-supplied identity field; the history routes never read a user
 *     id from the request at all.
 *   - `/status` returns only safe, non-secret `AiRuntimeStatus`; it never
 *     performs network or health checks.
 *   - `/instructions` is a THIN wrapper: it parses JSON (malformed → 400) and
 *     delegates to the existing persistent agent-turn service, which owns the
 *     bounded loop, provider fallback/rotation/cooldown, conversation
 *     ownership, and the tool policy/`invokeTool()` pipeline.
 *   - The history endpoints are THIN wrappers around the Phase 10.23
 *     `aiConversations` service (which in turn only calls the existing Phase
 *     10.7 repository): ownership scoping, connection-id validation, safe
 *     structured projection, and the 404/400 envelopes all live there — no
 *     conversation/database logic is duplicated here.
 *   - Phase 10.31: `GET /api/ai/conversations[/:conversationId]` also exposes
 *     per-conversation turn state — `turnState` (`approved` / `rejected` /
 *     `expired` / `awaiting-approval` / `completed` / `failed`) plus
 *     `pendingApprovals` (the still-decidable approvals). Both are derived
 *     server-side from the owned approvals and the last transcript row via
 *     the shared `toAiApproval`/`aiConversations` projection; approval
 *     arguments stay validated identifying references only — no new
 *     content-bearing fields are ever returned.
 *   - Returned data is safe by construction: persisted transcript text and
 *     structured tool metadata (with exact `fileId`/`versionId` REFERENCES
 *     kept as references only) — never raw file contents, provider secrets,
 *     or internal paths.
 */
import { Hono } from "hono";
import { getCurrentUser, requireAuth } from "../core/auth.js";
import type { AppVariables } from "../core/auth.js";
import { AppError } from "../core/errors.js";
import { getAiRuntimeStatus } from "../services/aiStatus.js";
import { runAiInstruction } from "../services/aiInstructions.js";
import {
  archiveAiConversation,
  deleteAiConversation,
  getAiConversation,
  listAiConversations,
  renameAiConversation,
  unarchiveAiConversation,
} from "../services/aiConversations.js";
import {
  approveToolApproval,
  listPendingToolApprovals,
  rejectToolApproval,
  toAiApproval,
  ToolApprovalExpiredError,
  ToolApprovalNotFoundError,
  ToolApprovalValidationError,
} from "../services/aiToolApprovals.js";

// ---------------------------------------------------------------------------
// Approval API helpers (Phase 10.28D)
// ---------------------------------------------------------------------------

/**
 * Map an approval-domain error to the matching HTTP envelope. Malformed ids →
 * 400; missing/foreign (deliberately indistinguishable) → 404; an elapsed
 * window → 400. Anything unexpected is rethrown to surface as a generic 500.
 */
function mapApprovalError(error: unknown): AppError {
  if (error instanceof ToolApprovalValidationError) {
    return AppError.badRequest(error.message);
  }
  if (error instanceof ToolApprovalNotFoundError) {
    return AppError.notFound("Tool approval");
  }
  if (error instanceof ToolApprovalExpiredError) {
    return AppError.badRequest(error.message);
  }
  throw error;
}

export const aiRoutes = new Hono<AppVariables>()
  .get("/status", requireAuth, (c) => {
    // The authenticated identity is required (defense in depth on top of
    // requireAuth); the payload itself is identity-independent.
    getCurrentUser(c);
    return c.json(getAiRuntimeStatus(), 200);
  })
  .post("/instructions", requireAuth, async (c) => {
    // The authenticated identity is required and CONSULTED ONLY via the
    // session — a body-supplied user id is rejected by the service's strict
    // parser and is never passed to the agent runtime.
    getCurrentUser(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw AppError.badRequest("Request body must be valid JSON.");
    }

    return c.json(await runAiInstruction(c, raw), 200);
  })
  .get("/conversations", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session. The list
    // service scopes every read to this user; the request carries no identity.
    // Optional `?q=` (Phase 10.27) is forwarded to the service, which trims,
    // validates, and scopes the title search — no query/database logic lives
    // in this route. Absent `q` is omitted so the no-search path is identical
    // to the pre-search behavior.
    const user = getCurrentUser(c);
    const q = c.req.query("q");
    const result =
      q === undefined ? await listAiConversations(user.id) : await listAiConversations(user.id, q);
    return c.json(result, 200);
  })
  .get("/conversations/:conversationId", requireAuth, async (c) => {
    // Ownership is enforced server-side: the service reads the conversation
    // scoped to the session user, so a foreign conversation is
    // indistinguishable from a missing one (existing 404 envelope).
    const user = getCurrentUser(c);
    const conversationId = c.req.param("conversationId");
    return c.json(await getAiConversation(user.id, conversationId), 200);
  })
  .delete("/conversations/:conversationId", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session; the service
    // ownership-scopes the delete, so a foreign or missing conversation (or a
    // repeated delete) is indistinguishable and all produce the existing 404.
    // Only the stable success result is returned — never the deleted contents.
    const user = getCurrentUser(c);
    const conversationId = c.req.param("conversationId");
    return c.json(await deleteAiConversation(user.id, conversationId), 200);
  })
  .patch("/conversations/:conversationId", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session. The rename
    // service scopes the write to this user; a body-supplied identity is
    // rejected — the route accepts ONLY the expected `title` field and
    // rejects any extra body fields.
    const user = getCurrentUser(c);
    const conversationId = c.req.param("conversationId");

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw AppError.badRequest("Request body must be valid JSON.");
    }

    // Reject unexpected body fields early; only `title` is accepted.
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const keys = Object.keys(raw as Record<string, unknown>);
      if (keys.length !== 1 || !Object.prototype.hasOwnProperty.call(raw, "title")) {
        throw AppError.badRequest("Only the title field is accepted.");
      }
    } else {
      throw AppError.badRequest("Request body must be a JSON object.");
    }

    const body = raw as { title: unknown };
    return c.json(await renameAiConversation(user.id, conversationId, body.title as string), 200);
  })
  .patch("/conversations/:conversationId/archive", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session. Archive is
    // ownership-scoped by the service/repository; a foreign or missing
    // conversation is indistinguishable and both produce the existing 404.
    // Only the stable safe metadata is returned — never transcript contents.
    const user = getCurrentUser(c);
    const conversationId = c.req.param("conversationId");
    return c.json(await archiveAiConversation(user.id, conversationId), 200);
  })
  .patch("/conversations/:conversationId/unarchive", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session. Unarchive is
    // ownership-scoped by the service/repository; a foreign or missing
    // conversation is indistinguishable and both produce the existing 404.
    const user = getCurrentUser(c);
    const conversationId = c.req.param("conversationId");
    return c.json(await unarchiveAiConversation(user.id, conversationId), 200);
  })
  .get("/approvals", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session. Listing is
    // ownership-scoped by the service/repository, so a user sees only their
    // own pending approvals — never another user's.
    const user = getCurrentUser(c);
    try {
      return c.json((await listPendingToolApprovals(user.id)).map(toAiApproval), 200);
    } catch (error) {
      throw mapApprovalError(error);
    }
  })
  .post("/approvals/:approvalId/approve", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session; the service
    // ownership-scopes the resolve, so a foreign/missing approval is a clean
    // 404. A resolved approval resolves idempotently to its terminal state.
    const user = getCurrentUser(c);
    const approvalId = c.req.param("approvalId");
    try {
      return c.json(toAiApproval(await approveToolApproval(user.id, approvalId)), 200);
    } catch (error) {
      throw mapApprovalError(error);
    }
  })
  .post("/approvals/:approvalId/reject", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session; the service
    // ownership-scopes the resolve, so a foreign/missing approval is a clean
    // 404. A resolved approval resolves idempotently to its terminal state.
    const user = getCurrentUser(c);
    const approvalId = c.req.param("approvalId");
    try {
      return c.json(toAiApproval(await rejectToolApproval(user.id, approvalId)), 200);
    } catch (error) {
      throw mapApprovalError(error);
    }
  });
