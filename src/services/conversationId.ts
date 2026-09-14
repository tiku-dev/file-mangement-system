/**
 * Conversation identifier conventions shared by the AI conversation APIs
 * (Phase 10.22 instructions + Phase 10.23 history).
 *
 * Conversation ids are persisted as UUIDs (`ai_conversations.id`, `@db.Uuid`).
 * Every API surface that accepts a conversation id validates it through THIS
 * module (the single convention), so malformed identifiers are rejected up
 * front with the existing generic `common/bad-request` envelope and never
 * reach the persistence layer.
 */
import { AppError } from "../core/errors.js";

/** UUID-shaped conversation identifier (uppercase accepted, normalized by the DB). */
export const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a string that matches the persisted UUID convention. */
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

/**
 * Validate an untrusted conversation id (body field or path param) against
 * the persisted UUID convention.
 *
 * @throws `AppError.badRequest` (400 `common/bad-request`) on malformed ids.
 */
export function validateConversationId(value: unknown): string {
  if (!isConversationId(value)) {
    throw AppError.badRequest("A valid conversationId is required.");
  }
  return value;
}