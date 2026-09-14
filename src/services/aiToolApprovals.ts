/**
 * AI tool-approval CONTRACT (Phase 10.28B) — the application layer that decides
 * whether, and against what, a tool approval is created and resolved, on top
 * of the `ai_tool_approvals` persistence (Phase 10.28A / SCHEMA.md §6.8).
 *
 * The contract is SMALL and provider-independent:
 *
 *   - CREATE validates the request BEFORE any write: the ids are UUID-shaped,
 *     `toolName` must be a REGISTERED tool, that tool must declare
 *     `requiresApproval: true` (absent/false tools — today all read tools —
 *     are never approvable), `arguments` must satisfy the tool's
 *     `inputSchema`, and `expiresAt` must be a future instant.
 *   - RESOLVE is explicit: the only decisions are approve / reject. Expiry is
 *     enforced at the decision boundary (`resolveToolApproval`) and in the
 *     executable guard — an expired approval can never be approved or
 *     executed.
 *   - OWNERSHIP is the authenticated user passed in by the caller and enforced
 *     structurally by the repository (`where: { userId }`); a foreign approval
 *     is indistinguishable from a missing one.
 *   - FILE OPERATIONS ARE NOT EXECUTED HERE — never. The contract only records
 *     and gates; the future execution layer must pass its approval through
 *     `assertToolApprovalExecutable` before any filesystem work.
 *   - SECRECY: only the validated `arguments` that identify the proposed
 *     operation are stored. No raw file contents, filesystem paths beyond the
 *     tool's own identifying arguments, provider responses, or model output
 *     ever enter an approval.
 *
 * The registry is injected so tests exercise the REAL registry/validation
 * path without a database; the repository is a thin persistence seam.
 */
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition, ToolInputSchema } from "../tools/types.js";
import { requiresToolApproval } from "../tools/types.js";
import { CONVERSATION_ID_PATTERN } from "./conversationId.js";
import {
  ToolApprovalStatus,
  ToolApprovalDecision,
  ToolApprovalAlreadyResolvedError,
  ToolApprovalDuplicateError,
  ToolApprovalExpiredError,
  ToolApprovalNotFoundError,
  consumeToolApproval as consumeToolApprovalRepo,
  createToolApproval,
  getPendingToolApproval,
  getToolApproval,
  listPendingToolApprovals as listPendingToolApprovalsRepo,
  listToolApprovalsForConversations as listToolApprovalsForConversationsRepo,
  resolveToolApproval,
  type ToolApprovalRecord,
} from "../database/repositories/aiToolApprovals.js";

// Re-export the full persistence surface under one contract import.
export {
  ToolApprovalStatus,
  ToolApprovalDecision,
  ToolApprovalAlreadyResolvedError,
  ToolApprovalDuplicateError,
  ToolApprovalExpiredError,
  ToolApprovalNotFoundError,
  getPendingToolApproval,
  getToolApproval,
  type ToolApprovalRecord,
};

// ---------------------------------------------------------------------------
// Contract errors (application-level gates)
// ---------------------------------------------------------------------------

/** Thrown when a request cannot form a valid approval. */
export class ToolApprovalValidationError extends Error {
  readonly code = "tool-approval/invalid-input";
  constructor(message: string) {
    super(message);
    this.name = "ToolApprovalValidationError";
  }
}

/** Thrown when `toolName` is not a registered tool. */
export class ToolApprovalUnknownToolError extends Error {
  readonly code = "tool-approval/unknown-tool";
  readonly toolName: string;
  constructor(toolName: string) {
    super(`No registered tool named "${toolName}".`);
    this.name = "ToolApprovalUnknownToolError";
    this.toolName = toolName;
  }
}

/** Thrown when a tool does not require user approval (not gated). */
export class ToolApprovalNotRequiredError extends Error {
  readonly code = "tool-approval/approval-not-required";
  readonly toolName: string;
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" does not require user approval, so an approval cannot be created for it.`,
    );
    this.name = "ToolApprovalNotRequiredError";
    this.toolName = toolName;
  }
}

/** Thrown when tool arguments do not satisfy the tool's input schema. */
export class ToolApprovalInvalidArgumentsError extends Error {
  readonly code = "tool-approval/invalid-arguments";
  readonly toolName: string;
  constructor(toolName: string, reason: string) {
    super(`Invalid arguments for tool "${toolName}": ${reason}`);
    this.name = "ToolApprovalInvalidArgumentsError";
    this.toolName = toolName;
  }
}

/** Thrown when an approval is not executable (not approved, or window elapsed). */
export class ToolApprovalNotExecutableError extends Error {
  readonly code = "tool-approval/not-executable";
  readonly status: string;
  constructor(status: string) {
    super(
      status === ToolApprovalStatus.Pending
        ? "This tool approval is still awaiting a decision."
        : `This tool approval is ${status} and cannot be executed.`,
    );
    this.name = "ToolApprovalNotExecutableError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// UUID-shape validation (shared convention, §conversationId.ts)
// ---------------------------------------------------------------------------

function isUuid(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Argument validation against a tool's input schema
// ---------------------------------------------------------------------------

function propertyTypeMatches(
  property: NonNullable<ToolInputSchema["properties"]>[string],
  value: unknown,
): boolean {
  switch (property.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        (property.items === undefined ||
          value.every((item) => propertyTypeMatches(property.items!, item)))
      );
    default:
      return false;
  }
}

/**
 * Validate untrusted tool arguments against the tool's simplified
 * `inputSchema`. Requires a JSON object, requires every schema-listed
 * required field, and type-checks every present schema-listed field.
 * Unknown extra keys are tolerated (handlers ignore fields they do not
 * declare). Pure — throws `ToolApprovalInvalidArgumentsError` on violation.
 */
export function validateToolApprovalArguments(
  toolName: string,
  schema: ToolInputSchema,
  args: unknown,
): void {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ToolApprovalInvalidArgumentsError(toolName, "arguments must be a JSON object.");
  }
  const record = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in record)) {
      throw new ToolApprovalInvalidArgumentsError(toolName, `missing required argument "${key}".`);
    }
  }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (!(key in record)) continue;
    if (!propertyTypeMatches(property, record[key]!)) {
      throw new ToolApprovalInvalidArgumentsError(
        toolName,
        `argument "${key}" must be a ${property.type}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateAiToolApprovalRequest {
  /** The authenticated user requesting/owning the approval. */
  userId: string;
  /** uuid of the owning AI conversation (validated here). */
  conversationId: unknown;
  /** uuid of the persisted message/turn that produced the request. */
  messageId: unknown;
  /** Registered tool name to gate. */
  toolName: unknown;
  /** Untrusted tool arguments — validated against the tool's schema. */
  arguments: unknown;
  /** End of the approval window, as a `Date` strictly after `now`. */
  expiresAt: unknown;
  /** Injectable "now"; defaults to `new Date()`. */
  now?: Date;
}

export interface AiToolApprovalDependencies {
  /** The real in-memory tool registry (Phase 9.1) — never bypassed. */
  registry: ToolRegistry;
}

/**
 * Create a pending approval after validating the FULL request against the
 * tool registry: known tool, `requiresApproval: true`, schema-valid
 * arguments, a future expiry. Defers the pending-row write to the repository
 * (which enforces the one-pending-per-(message, tool) rule and ownership).
 *
 * @throws `ToolApprovalValidationError` on malformed ids / expiry.
 * @throws `ToolApprovalUnknownToolError` for unregistered tool names.
 * @throws `ToolApprovalNotRequiredError` when the tool is not approval-gated.
 * @throws `ToolApprovalInvalidArgumentsError` for schema-invalid arguments.
 * @throws the repository's duplicate/DB errors unchanged.
 */
export async function createAiToolApproval(
  request: CreateAiToolApprovalRequest,
  deps: AiToolApprovalDependencies,
): Promise<ToolApprovalRecord> {
  if (typeof request.userId !== "string" || request.userId.length === 0) {
    throw new ToolApprovalValidationError("A non-empty userId is required.");
  }
  if (!isUuid(request.conversationId)) {
    throw new ToolApprovalValidationError("A valid conversationId is required.");
  }
  if (!isUuid(request.messageId)) {
    throw new ToolApprovalValidationError("A valid messageId is required.");
  }

  const now = request.now ?? new Date();
  const expiresAt = request.expiresAt;
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new ToolApprovalValidationError("expiresAt must be a valid Date.");
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new ToolApprovalValidationError("expiresAt must be in the future.");
  }

  if (typeof request.toolName !== "string" || request.toolName.length === 0) {
    throw new ToolApprovalValidationError("A non-empty toolName is required.");
  }

  let definition: Readonly<ToolDefinition>;
  try {
    definition = deps.registry.get(request.toolName);
  } catch {
    // Registry miss = the request references an unknown, unblessed tool.
    throw new ToolApprovalUnknownToolError(request.toolName);
  }

  if (!requiresToolApproval(definition)) {
    throw new ToolApprovalNotRequiredError(definition.name);
  }

  validateToolApprovalArguments(definition.name, definition.inputSchema, request.arguments);

  return createToolApproval({
    userId: request.userId,
    conversationId: request.conversationId,
    messageId: request.messageId,
    toolName: definition.name,
    arguments: request.arguments,
    expiresAt,
    now,
  });
}

// ---------------------------------------------------------------------------
// Resolve (explicit decisions: approve / reject only)
// ---------------------------------------------------------------------------

/**
 * Approve a pending approval. The decision is explicit and terminal.
 * Ownership + state machine + expiry are enforced by the repository.
 *
 * @throws `ToolApprovalValidationError` on a malformed approval id.
 * @throws repository errors unchanged (`ToolApprovalNotFoundError`,
 *         `ToolApprovalAlreadyResolvedError`, `ToolApprovalExpiredError`).
 */
export async function approveAiToolApproval(
  userId: string,
  approvalId: unknown,
  now: Date = new Date(),
): Promise<ToolApprovalRecord> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new ToolApprovalValidationError("A non-empty userId is required.");
  }
  if (!isUuid(approvalId)) {
    throw new ToolApprovalValidationError("A valid approvalId is required.");
  }
  return resolveToolApproval(userId, approvalId, ToolApprovalDecision.Approve, now);
}

/**
 * Reject a pending approval. The decision is explicit and terminal.
 *
 * @throws `ToolApprovalValidationError` on a malformed approval id.
 * @throws repository errors unchanged (`ToolApprovalNotFoundError`,
 *         `ToolApprovalAlreadyResolvedError`, `ToolApprovalExpiredError`).
 */
export async function rejectAiToolApproval(
  userId: string,
  approvalId: unknown,
  now: Date = new Date(),
): Promise<ToolApprovalRecord> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new ToolApprovalValidationError("A non-empty userId is required.");
  }
  if (!isUuid(approvalId)) {
    throw new ToolApprovalValidationError("A valid approvalId is required.");
  }
  return resolveToolApproval(userId, approvalId, ToolApprovalDecision.Reject, now);
}

// ---------------------------------------------------------------------------
// Idempotent resolve for the authenticated API (Phase 10.28D)
// ---------------------------------------------------------------------------
//
// The API must return a consistent terminal state rather than error when the
// same decision is submitted twice (or a decision is re-submitted after the
// approval already resolved). These wrappers resolve through the existing
// contract and, on an `AlreadyResolvedError`, load and return the OWNED record
// — so a repeated approve/reject is safe and idempotent, and a foreign/missing
// approval stays a clean 404 (the repository returns null → NotFoundError).

/**
 * Approve a pending approval idempotently. Resolves the approval through the
 * existing contract; if it was already resolved, returns the existing terminal
 * record instead of erroring. Ownership is enforced by the repository on both
 * the resolve and the fallback load, so a foreign/missing approval throws
 * `ToolApprovalNotFoundError`.
 *
 * @throws `ToolApprovalValidationError` on a malformed id.
 * @throws `ToolApprovalNotFoundError` when the approval does not exist for
 *         `userId` (indistinguishable from foreign ownership).
 * @throws `ToolApprovalExpiredError` when the approval window has elapsed.
 */
export async function approveToolApproval(
  userId: string,
  approvalId: unknown,
  now: Date = new Date(),
): Promise<ToolApprovalRecord> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new ToolApprovalValidationError("A non-empty userId is required.");
  }
  if (!isUuid(approvalId)) {
    throw new ToolApprovalValidationError("A valid approvalId is required.");
  }
  try {
    return await resolveToolApproval(userId, approvalId, ToolApprovalDecision.Approve, now);
  } catch (error) {
    if (error instanceof ToolApprovalAlreadyResolvedError) {
      const existing = await getToolApproval(userId, approvalId);
      if (existing === null) throw new ToolApprovalNotFoundError();
      return existing;
    }
    throw error;
  }
}

/**
 * Reject a pending approval idempotently. Mirrors `approveToolApproval`: resolves
 * through the existing contract and returns the owned terminal record on a
 * repeat decision.
 *
 * @throws `ToolApprovalValidationError` on a malformed id.
 * @throws `ToolApprovalNotFoundError` when the approval does not exist for
 *         `userId` (indistinguishable from foreign ownership).
 * @throws `ToolApprovalExpiredError` when the approval window has elapsed.
 */
export async function rejectToolApproval(
  userId: string,
  approvalId: unknown,
  now: Date = new Date(),
): Promise<ToolApprovalRecord> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new ToolApprovalValidationError("A non-empty userId is required.");
  }
  if (!isUuid(approvalId)) {
    throw new ToolApprovalValidationError("A valid approvalId is required.");
  }
  try {
    return await resolveToolApproval(userId, approvalId, ToolApprovalDecision.Reject, now);
  } catch (error) {
    if (error instanceof ToolApprovalAlreadyResolvedError) {
      const existing = await getToolApproval(userId, approvalId);
      if (existing === null) throw new ToolApprovalNotFoundError();
      return existing;
    }
    throw error;
  }
}

/**
 * List the authenticated user's pending tool approvals, oldest-first. Ownership
 * is structural; only `pending` rows are returned. Pure projection — the
 * repository record is already safe (validated arguments only, no secrets).
 */
export async function listPendingToolApprovals(userId: string): Promise<ToolApprovalRecord[]> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new ToolApprovalValidationError("A non-empty userId is required.");
  }
  return listPendingToolApprovalsRepo(userId);
}

/**
 * Consume an already-EXECUTED `approved` approval (Phase 10.30), sealing it so
 * it can never be replayed or double-executed. The row stays `approved` but
 * its window is backdated to `now`, so every later executable guard treats it
 * as expired. Ownership is enforced by the repository.
 *
 * @throws `ToolApprovalValidationError` on a malformed approval id.
 * @throws repository errors unchanged (`ToolApprovalNotFoundError`,
 *         `ToolApprovalAlreadyResolvedError`, `ToolApprovalExpiredError`).
 */
export async function consumeToolApproval(
  userId: string,
  approvalId: unknown,
  now: Date = new Date(),
): Promise<ToolApprovalRecord> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new ToolApprovalValidationError("A non-empty userId is required.");
  }
  if (!isUuid(approvalId)) {
    throw new ToolApprovalValidationError("A valid approvalId is required.");
  }
  return consumeToolApprovalRepo(userId, approvalId, now);
}

// ---------------------------------------------------------------------------
// Shared safe projection for the conversation history API (Phase 10.31)
// ---------------------------------------------------------------------------

/**
 * Safe, content-free projection of one persisted approval for authenticated
 * API responses. `arguments` are the validated tool arguments (they may carry
 * the tool's OWN identifying fields but never raw contents); the owner's
 * `userId` is deliberately dropped because it is implied by authentication.
 * Timestamps are ISO strings.
 */
export interface AiToolApproval {
  id: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
  status: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

/** Pure projection of a persisted record into the safe API shape. */
export function toAiApproval(record: ToolApprovalRecord): AiToolApproval {
  return {
    id: record.id,
    conversationId: record.conversationId,
    messageId: record.messageId,
    toolName: record.toolName,
    arguments: record.arguments as Readonly<Record<string, unknown>>,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    decidedAt: record.decidedAt === null ? null : record.decidedAt.toISOString(),
  };
}

/**
 * List EVERY approval owned by `userId` for `conversationIds` (all states,
 * oldest-first), projected through `toAiApproval`. Empty input returns `[]`
 * without a database read.
 */
export async function listConversationToolApprovals(
  userId: string,
  conversationIds: readonly string[],
): Promise<AiToolApproval[]> {
  if (conversationIds.length === 0) return [];
  const records = await listToolApprovalsForConversationsRepo(userId, conversationIds);
  return records.map(toAiApproval);
}

// ---------------------------------------------------------------------------
// Execution gate (no filesystem work happens here)
// ---------------------------------------------------------------------------

/**
 * Whether an approval currently authorizes execution: it must be `approved`
 * AND inside its window (`now < expiresAt`). Pure.
 */
export function isToolApprovalExecutable(approval: ToolApprovalRecord, now: Date): boolean {
  return (
    approval.status === ToolApprovalStatus.Approved && now.getTime() < approval.expiresAt.getTime()
  );
}

/**
 * Guard the future execution layer must pass before acting on an approval.
 *
 * @throws `ToolApprovalNotExecutableError` when the approval is not
 *         `approved`; `ToolApprovalExpiredError` when the approval window has
 *         elapsed (an expired approval cannot be executed).
 */
export function assertToolApprovalExecutable(approval: ToolApprovalRecord, now: Date): void {
  if (approval.status !== ToolApprovalStatus.Approved) {
    throw new ToolApprovalNotExecutableError(approval.status);
  }
  if (now.getTime() >= approval.expiresAt.getTime()) {
    throw new ToolApprovalExpiredError();
  }
}
