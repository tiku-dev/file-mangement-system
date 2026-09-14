/**
 * Agent conversation repository — the ONLY place agent-conversation state
 * persistence touches Prisma (Phase 10.7).
 *
 * Boundary rules (database/README): no HTTP semantics, no Hono deps, no
 * filesystem access, no provider calls, no network. It persists the Phase
 * 10.6 `ConversationState` contract provider-independently, keyed under an
 * authenticated user's ownership. Ownership is enforced on every load and
 * modify: a `conversationId` that is not owned by `userId` is
 * indistinguishable from one that does not exist (returns `null` / throws
 * `AgentConversationNotFoundError`). Only raw structured tool data is
 * stored — never file contents.
 *
 * Storage shape (one `ai_messages` row per recorded step, order =
 * `(created_at, id)`):
 *
 *   - user instruction          -> role 'user'
 *   - a provider round          -> role 'assistant' with `tool_calls` JSONB
 *                                  and the round's `tool_results` JSONB
 *   - the terminal agent reply  -> role 'assistant' with `is_final = true`
 *
 * The conversation row's `max_tool_rounds` is the loop bound so turn
 * progress (`toolRounds`, `remainingToolRounds`) is reconstructible without
 * re-implementing the bounded loop.
 */
import { getDatabase } from "../client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { AgentToolCall, AgentToolResult } from "../../services/agent.js";
import {
  createConversationState,
  finalizeConversation,
  recordProviderTurn,
  recordToolResults,
  validateToolCalls,
  validateToolResults,
  type ConversationState,
} from "../../services/conversation.js";
import { ToolError, type ToolErrorCategory } from "../../tools/errors.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a conversation id is unknown OR belongs to another user
 *  (both are deliberately indistinguishable). */
export class AgentConversationNotFoundError extends Error {
  readonly code = "agent-conversation/not-found-or-not-owned";
  constructor() {
    super("Agent conversation not found for this user.");
    this.name = "AgentConversationNotFoundError";
  }
}

/** Thrown when stored rows cannot form a valid `ConversationState`. */
export class AgentConversationCorruptError extends Error {
  readonly code = "agent-conversation/corrupt";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentConversationCorruptError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredConversation {
  id: string;
  userId: string;
  title: string | null;
  maxToolRounds: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateAgentConversationInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** The user's instruction — persisted as the conversation's first message. */
  instruction: string;
  /** Strict loop bound (mirrors Phase 10.6 `maxToolRounds`). */
  maxToolRounds: number;
  /** Optional display title. */
  title?: string;
}

/** One recorded provider round: free-form text, its tool-call intents, and
 *  the structured results of executing those intents. */
export interface AgentTurnInput {
  text?: string;
  toolCalls?: readonly AgentToolCall[];
  toolResults?: readonly AgentToolResult[];
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function assertStoredText(text: unknown, label: string): string | undefined {
  if (text === undefined) return undefined;
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError(`${label} must be a non-empty string when present.`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Create / append
// ---------------------------------------------------------------------------

/**
 * Create a conversation and persist the user's instruction as its first
 * message, atomically. The given instruction/bound are validated by the
 * Phase 10.6 `createConversationState` before anything is written.
 */
export async function createAgentConversation(
  input: CreateAgentConversationInput,
): Promise<StoredConversation> {
  const state = createConversationState({
    instruction: input.instruction,
    maxToolRounds: input.maxToolRounds,
  });
  const db = getDatabase();
  const created = await db.$transaction(async (tx) => {
    const conversation = await tx.aiConversation.create({
      data: {
        userId: input.userId,
        maxToolRounds: state.maxToolRounds,
        title: input.title ?? null,
      },
    });
    await tx.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: state.instruction,
      },
    });
    return conversation;
  });
  return {
    id: created.id,
    userId: created.userId,
    title: created.title,
    maxToolRounds: created.maxToolRounds,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
    archivedAt: created.archivedAt,
  };
}

/**
 * Append a provider round to a user-owned conversation: an `assistant`
 * message carrying the round's free-form text, its tool-call intents
 * (`tool_calls`), and the round's structured results (`tool_results`).
 * Ownership is verified inside the same transaction that writes, so a
 * foreign owner cannot modify a conversation. Invalid intents/results throw
 * `TypeError` before anything is written.
 */
export async function appendAgentTurn(
  userId: string,
  conversationId: string,
  input: AgentTurnInput,
): Promise<void> {
  const text = assertStoredText(input.text, "provider text");
  const toolCalls = input.toolCalls === undefined ? undefined : validateToolCalls(input.toolCalls);
  if (text === undefined && toolCalls === undefined) {
    throw new TypeError("A provider turn must include text or toolCalls.");
  }
  const toolResults =
    input.toolResults === undefined ? undefined : validateToolResults(input.toolResults);

  const db = getDatabase();
  await db.$transaction(async (tx) => {
    const owned = await tx.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (owned === null) throw new AgentConversationNotFoundError();
    await tx.aiMessage.create({
      data: {
        conversationId,
        role: "assistant",
        content: text ?? "",
        ...(toolCalls !== undefined ? { toolCalls: asJson(toolCalls) } : {}),
        ...(toolResults !== undefined ? { toolResults: asJson(toolResults) } : {}),
      },
    });
    await bumpUpdatedAt(tx, conversationId);
  });
}

/**
 * Append the terminal agent reply to a user-owned conversation (`is_final =
 * true`). Ownership is verified inside the same transaction as the write.
 */
export async function appendAgentFinal(
  userId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  const finalText = assertStoredText(text, "final text");
  if (finalText === undefined) {
    throw new TypeError("final text must be a non-empty string.");
  }
  const db = getDatabase();
  await db.$transaction(async (tx) => {
    const owned = await tx.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (owned === null) throw new AgentConversationNotFoundError();
    await tx.aiMessage.create({
      data: { conversationId, role: "assistant", content: finalText, isFinal: true },
    });
    await bumpUpdatedAt(tx, conversationId);
  });
}

// ---------------------------------------------------------------------------
// Atomic turn persistence (Phase 10.8)
// ---------------------------------------------------------------------------

/** One executed provider round to persist: text, intents, and results. */
export interface AgentTurnRecord {
  text?: string;
  toolCalls?: readonly AgentToolCall[];
  toolResults?: readonly AgentToolResult[];
}

export interface PersistAgentTurnInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** Present → resume this conversation (ownership enforced); absent → create a new one. */
  conversationId?: string;
  /** The user's instruction for this turn. Always persisted as the first row. */
  instruction: string;
  /** Loop bound used when CREATING a conversation (ignored when resuming). */
  maxToolRounds: number;
  /** Optional display title for newly created conversations. */
  title?: string;
  /** Executed provider rounds, in order. */
  rounds: readonly AgentTurnRecord[];
  /** The terminal agent reply. */
  finalText: string;
}

export interface PersistAgentTurnResult {
  /** The conversation id (existing or newly created). */
  id: string;
  /** True when a new conversation was created for this turn. */
  created: boolean;
}

/** Validate ONE provider round through the Phase 10.6 validators. */
function validateAgentRound(round: AgentTurnRecord): {
  text?: string;
  toolCalls?: readonly AgentToolCall[];
  toolResults?: readonly AgentToolResult[];
} {
  const text = assertStoredText(round.text, "provider text");
  const toolCalls = round.toolCalls === undefined ? undefined : validateToolCalls(round.toolCalls);
  if (text === undefined && toolCalls === undefined) {
    throw new TypeError("A provider round must include text or toolCalls.");
  }
  const toolResults =
    round.toolResults === undefined ? undefined : validateToolResults(round.toolResults);
  return {
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolResults !== undefined ? { toolResults } : {}),
  };
}

/**
 * Persist a COMPLETE agent turn atomically (Phase 10.8): user instruction →
 * executed provider rounds → terminal reply, all in ONE transaction. A new
 * conversation is created when `conversationId` is absent; otherwise
 * ownership is verified inside the same transaction (foreign/missing ids
 * throw `AgentConversationNotFoundError`). Every row is committed or NONE is,
 * so a failed turn can never leave a partial transcript. Inputs are validated
 * up front through the phase 10.6 guards (`createConversationState`,
 * `validateToolCalls`, `validateToolResults`) before any write.
 *
 * Rows share the transaction's timestamp, so `created_at` is sequenced
 * explicitly to keep the (created_at, id) transcript order deterministic.
 */
export async function persistAgentTurn(
  input: PersistAgentTurnInput,
): Promise<PersistAgentTurnResult> {
  const state = createConversationState({
    instruction: input.instruction,
    maxToolRounds: input.maxToolRounds,
  });
  const rounds = input.rounds.map(validateAgentRound);
  const finalText = assertStoredText(input.finalText, "final text");
  if (finalText === undefined) {
    throw new TypeError("final text must be a non-empty string.");
  }

  const db = getDatabase();
  return db.$transaction(async (tx) => {
    let id: string;
    let created: boolean;
    if (input.conversationId === undefined) {
      const conversation = await tx.aiConversation.create({
        data: {
          userId: input.userId,
          maxToolRounds: state.maxToolRounds,
          title: input.title ?? null,
        },
      });
      id = conversation.id;
      created = true;
    } else {
      const owned = await tx.aiConversation.findFirst({
        where: { id: input.conversationId, userId: input.userId },
        select: { id: true },
      });
      if (owned === null) throw new AgentConversationNotFoundError();
      id = owned.id;
      created = false;
    }

    const base = Date.now();
    let step = 0;
    const createdAt = () => new Date(base + step++);

    await tx.aiMessage.create({
      data: {
        conversationId: id,
        role: "user",
        content: state.instruction,
        createdAt: createdAt(),
      },
    });
    for (const round of rounds) {
      await tx.aiMessage.create({
        data: {
          conversationId: id,
          role: "assistant",
          content: round.text ?? "",
          ...(round.toolCalls !== undefined ? { toolCalls: asJson(round.toolCalls) } : {}),
          ...(round.toolResults !== undefined ? { toolResults: asJson(round.toolResults) } : {}),
          createdAt: createdAt(),
        },
      });
    }
    await tx.aiMessage.create({
      data: {
        conversationId: id,
        role: "assistant",
        content: finalText,
        isFinal: true,
        createdAt: createdAt(),
      },
    });
    await tx.aiConversation.update({ where: { id }, data: { updatedAt: new Date() } });
    return { id, created };
  });
}

// ---------------------------------------------------------------------------
// Eager turn persistence (Phase 10.28C-prep)
// ---------------------------------------------------------------------------
//
// The approval contract (Phase 10.28A/B) requires a REAL persisted
// conversationId + messageId at the tool-invocation boundary, but tool
// execution happens BEFORE the turn ends. A persistent turn therefore
// persists eagerly, in three ordered steps:
//
//   1. beginAgentTurn            — conversation (new or owned) + instruction
//                                  message + FIRST round assistant message
//                                  (committed, real ids returned);
//   2. appendAgentTurnRoundMessage — each LATER round's assistant message,
//                                  committed before that round's intents run;
//   3. completeAgentTurn         — ONE transaction: attach every round's
//                                  `tool_results` to its message, append the
//                                  is_final reply, bump updated_at.
//
// If the turn fails after any eager commit, the caller compensates with
// cancelAgentTurn: a newly created conversation is deleted (cascade), or a
// resumed conversation has exactly the turn's own messages removed — so the
// failure restores the conversation to its prior state (no partial turn).

export interface BeginAgentTurnInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** Resume this conversation (ownership enforced). Omit to create one. */
  conversationId?: string;
  /** The user's instruction, persisted as the first message. */
  instruction: string;
  /** Strict loop bound. */
  maxToolRounds: number;
  /** Optional display title for newly created conversations. */
  title?: string;
  /** The first round's free-form provider text (when present). */
  text?: string;
  /** The first round's validated tool-call intents. */
  toolCalls: readonly AgentToolCall[];
}

export interface BeginAgentTurnResult {
  /** The conversation id (existing or newly created). */
  conversationId: string;
  /** True when this turn created the conversation. */
  created: boolean;
  /** Persisted user-instruction message id (for failure cleanup). */
  instructionMessageId: string;
  /** Persisted FIRST-round assistant/tool-call message id. */
  messageId: string;
}

/**
 * Begin a persistent agent turn: create the conversation (when `conversationId`
 * is absent) or verify ownership (when resuming), persist the user's
 * instruction message, and persist the FIRST tool-call round's assistant
 * message — all in ONE transaction. The returned `messageId` is a real
 * committed row id ready for tool execution. Ownership is enforced inside
 * the same transaction.
 *
 * @throws `AgentConversationNotFoundError` when resuming a conversation that
 *         does not exist for `userId` (indistinguishable from foreign).
 * @throws `TypeError` when `instruction`, `toolCalls`, or `maxToolRounds` are
 *         invalid (validated before any write, via the Phase 10.6 guards).
 */
export async function beginAgentTurn(
  input: BeginAgentTurnInput,
): Promise<BeginAgentTurnResult> {
  const state = createConversationState({
    instruction: input.instruction,
    maxToolRounds: input.maxToolRounds,
  });
  const text = assertStoredText(input.text, "provider text");
  const toolCalls = validateToolCalls(input.toolCalls);

  const db = getDatabase();
  return db.$transaction(async (tx) => {
    let id: string;
    let created: boolean;
    if (input.conversationId === undefined) {
      const conversation = await tx.aiConversation.create({
        data: {
          userId: input.userId,
          maxToolRounds: state.maxToolRounds,
          title: input.title ?? null,
        },
      });
      id = conversation.id;
      created = true;
    } else {
      const owned = await tx.aiConversation.findFirst({
        where: { id: input.conversationId, userId: input.userId },
        select: { id: true },
      });
      if (owned === null) throw new AgentConversationNotFoundError();
      id = owned.id;
      created = false;
    }
    const instruction = await tx.aiMessage.create({
      data: {
        conversationId: id,
        role: "user",
        content: state.instruction,
      },
    });
    const round = await tx.aiMessage.create({
      data: {
        conversationId: id,
        role: "assistant",
        content: text ?? "",
        toolCalls: asJson(toolCalls),
      },
    });
    return {
      conversationId: id,
      created,
      instructionMessageId: instruction.id,
      messageId: round.id,
    };
  });
}

export interface AppendAgentRoundInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** Owned conversation to append to. */
  conversationId: string;
  /** The round's free-form provider text (when present). */
  text?: string;
  /** The round's validated tool-call intents. */
  toolCalls: readonly AgentToolCall[];
}

export interface AppendAgentRoundResult {
  /** Persisted assistant/tool-call message id for this round. */
  messageId: string;
}

/**
 * Persist ONE later tool-call round's assistant message (Phase 10.28C-prep)
 * in its OWN transaction, BEFORE that round's intents execute. Ownership is
 * verified inside the same transaction that writes.
 *
 * @throws `AgentConversationNotFoundError` when the conversation does not
 *         exist for `userId` (indistinguishable from foreign ownership).
 * @throws `TypeError` on invalid tool calls (validated before any write).
 */
export async function appendAgentTurnRoundMessage(
  input: AppendAgentRoundInput,
): Promise<AppendAgentRoundResult> {
  const text = assertStoredText(input.text, "provider text");
  const toolCalls = validateToolCalls(input.toolCalls);

  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const owned = await tx.aiConversation.findFirst({
      where: { id: input.conversationId, userId: input.userId },
      select: { id: true },
    });
    if (owned === null) throw new AgentConversationNotFoundError();
    const round = await tx.aiMessage.create({
      data: {
        conversationId: input.conversationId,
        role: "assistant",
        content: text ?? "",
        toolCalls: asJson(toolCalls),
      },
    });
    return { messageId: round.id };
  });
}

export interface CompleteAgentTurnRound {
  /** Persisted assistant message id for the round (from begin/append). */
  messageId: string;
  /** Structured results of executing that round's intents. */
  toolResults: readonly AgentToolResult[];
}

export interface CompleteAgentTurnInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** Owned conversation the eager rows were created in. */
  conversationId: string;
  /** Executed rounds, in order, each mapped to its persisted message. */
  rounds: readonly CompleteAgentTurnRound[];
  /** The terminal agent reply (becomes the is_final message). */
  finalText: string;
}

/**
 * Complete an eagerly-begun persistent turn in ONE transaction: attach each
 * round's `tool_results` to its persisted assistant message, append the
 * `is_final` reply, and bump `updated_at`. Ownership is verified inside the
 * transaction; a round message that vanished (e.g. concurrent delete) throws
 * `AgentConversationNotFoundError` and rolls everything back.
 *
 * @throws `AgentConversationNotFoundError` on missing/foreign conversation or
 *         an unknown round message id.
 * @throws `TypeError` on invalid tool results / missing final text.
 */
export async function completeAgentTurn(
  input: CompleteAgentTurnInput,
): Promise<void> {
  const finalText = assertStoredText(input.finalText, "final text");
  if (finalText === undefined) {
    throw new TypeError("final text must be a non-empty string.");
  }
  const rounds = input.rounds.map((round) => ({
    messageId: round.messageId,
    toolResults: validateToolResults(round.toolResults),
  }));

  const db = getDatabase();
  await db.$transaction(async (tx) => {
    const owned = await tx.aiConversation.findFirst({
      where: { id: input.conversationId, userId: input.userId },
      select: { id: true },
    });
    if (owned === null) throw new AgentConversationNotFoundError();
    for (const round of rounds) {
      const updated = await tx.aiMessage.updateMany({
        where: { id: round.messageId, conversationId: input.conversationId },
        data: { toolResults: asJson(round.toolResults) },
      });
      if (updated.count === 0) throw new AgentConversationNotFoundError();
    }
    await tx.aiMessage.create({
      data: {
        conversationId: input.conversationId,
        role: "assistant",
        content: finalText,
        isFinal: true,
      },
    });
    await bumpUpdatedAt(tx, input.conversationId);
  });
}

export interface CancelAgentTurnInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** The conversation the eager rows were created in. */
  conversationId: string;
  /** True when this turn created the conversation (delete it entirely). */
  created: boolean;
  /** Message ids this turn wrote (deleted when resuming a conversation). */
  messageIds: readonly string[];
}

/**
 * Compensate a failed eagerly-begun turn so NO partial turn state remains
 * (Phase 10.28C-prep). A turn that created its conversation deletes that
 * conversation (the schema's ON DELETE CASCADE removes its messages); a
 * resumed turn deletes exactly the instruction + round messages this turn
 * wrote — the conversation returns to its prior state. Idempotent and
 * ownership-scoped: deleting a foreign/missing conversation or already
 * removed messages is a safe no-op.
 */
export async function cancelAgentTurn(
  input: CancelAgentTurnInput,
): Promise<void> {
  const db = getDatabase();
  if (input.created) {
    await db.aiConversation.deleteMany({
      where: { id: input.conversationId, userId: input.userId },
    });
    return;
  }
  if (input.messageIds.length === 0) return;
  await db.aiMessage.deleteMany({
    where: {
      id: { in: [...input.messageIds] },
      conversationId: input.conversationId,
      conversation: { is: { userId: input.userId } },
    },
  });
}

/** Bump `updated_at` (the schema promises it bumps on new messages). */
async function bumpUpdatedAt(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<void> {
  await tx.aiConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export interface StoredMessage {
  role: string;
  content: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  isFinal: boolean;
  createdAt: Date;
}

/**
 * Load a user-owned conversation back into a live Phase 10.6 state, or
 * `null` when the conversation does not exist for `userId` (ownership
 * enforced — a foreign conversation is indistinguishable from a missing
 * one). Reconstructs the state by replaying stored rows through the 10.6
 * transitions, which re-validates every stored value and rejects
 * malformed/corrupt rows with `AgentConversationCorruptError`.
 */
export async function loadAgentConversationState(
  userId: string,
  conversationId: string,
): Promise<ConversationState | null> {
  const db = getDatabase();
  const conversation = await db.aiConversation.findFirst({
    where: { id: conversationId, userId },
    select: { maxToolRounds: true },
  });
  if (conversation === null) return null;
  const stored = await db.aiMessage.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return reconstructConversationState(conversation.maxToolRounds, stored);
}

// ---------------------------------------------------------------------------
// List / read history (Phase 10.23)
// ---------------------------------------------------------------------------

/** A persisted transcript row (with its stable row id). */
export interface StoredMessageRecord extends StoredMessage {
  id: string;
}

/** A conversation plus its persisted transcript rows (chronological). */
export interface StoredConversationDetail {
  conversation: StoredConversation;
  messages: readonly StoredMessageRecord[];
}

function toStoredConversation(row: {
  id: string;
  userId: string;
  title: string | null;
  maxToolRounds: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}): StoredConversation {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    maxToolRounds: row.maxToolRounds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

function toStoredMessage(row: {
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
  isFinal: boolean;
  createdAt: Date;
}): StoredMessage {
  return {
    role: row.role,
    content: row.content,
    toolCalls: row.toolCalls ?? undefined,
    toolResults: row.toolResults ?? undefined,
    isFinal: row.isFinal,
    createdAt: row.createdAt,
  };
}

function toStoredMessageRecord(row: {
  id: string;
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
  isFinal: boolean;
  createdAt: Date;
}): StoredMessageRecord {
  return { id: row.id, ...toStoredMessage(row) };
}

/**
 * List the conversations OWNED by `userId`, newest-first. Deterministic
 * order: most-recently-updated first, then most-recently-created, then by
 * stable id. Uses the `(user_id, updated_at DESC)` conversation-list index.
 *
 * Optional Phase 10.27 `titleQuery`: when a non-empty string is provided the
 * list is additionally filtered to owned conversations whose title CONTAINS
 * the query, case-insensitively (`ILIKE '%query%'` — a plain Postgres text
 * scan, no new index). Search covers ONLY the visible title: raw message
 * contents, tool results, and file contents are never matched.
 */
export async function listAgentConversations(
  userId: string,
  titleQuery?: string,
): Promise<StoredConversation[]> {
  const db = getDatabase();
  const rows = await db.aiConversation.findMany({
    // Phase 10.26B: the NORMAL conversation list excludes archived
    // conversations by default (archived_at IS NULL).
    where: {
      userId,
      archivedAt: null,
      // Phase 10.27: title substring search (case-insensitive). Absent or
      // empty `titleQuery` → no additional filter (preserves the existing
      // list exactly).
      ...(titleQuery !== undefined && titleQuery.length > 0
        ? { title: { contains: titleQuery, mode: "insensitive" } }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      userId: true,
      title: true,
      maxToolRounds: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
    },
  });
  return rows.map(toStoredConversation);
}

/**
 * Retrieve ONE conversation OWNED by `userId` with its persisted transcript
 * in chronological order, or `null` when the conversation does not exist for
 * `userId` (ownership enforced — a foreign conversation is indistinguishable
 * from a missing one). Raw structured tool data (intents, results, exact
 * `fileId`/`versionId` references) is returned as stored — never file
 * contents; the caller is responsible for safe presentation shaping.
 */
export async function getAgentConversation(
  userId: string,
  conversationId: string,
): Promise<StoredConversationDetail | null> {
  const db = getDatabase();
  const conversation = await db.aiConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      id: true,
      userId: true,
      title: true,
      maxToolRounds: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
    },
  });
  if (conversation === null) return null;
  const messages = await db.aiMessage.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return {
    conversation: toStoredConversation(conversation),
    messages: messages.map(toStoredMessageRecord),
  };
}

// ---------------------------------------------------------------------------
// Last-turn per conversation (Phase 10.31)
// ---------------------------------------------------------------------------

/** One owned conversation's LAST persisted transcript row. */
export interface StoredLastMessage {
  conversationId: string;
  messageId: string;
  role: string;
  isFinal: boolean;
}

/**
 * Return each owned conversation's LAST persisted message (chronological
 * `(createdAt, id)` order), only for conversations belonging to `userId`.
 * A conversation with no transcript rows (or not owned by `userId`) is
 * omitted entirely — ownership is enforced via the `conversation` relation,
 * so a foreign conversation is indistinguishable from a missing one. Used by
 * the history service (Phase 10.31) to distinguish a completed turn (ends
 * with an `is_final` reply) from a failed/incomplete one.
 */
export async function listConversationLastMessages(
  userId: string,
  conversationIds: readonly string[],
): Promise<StoredLastMessage[]> {
  if (conversationIds.length === 0) return [];
  const db = getDatabase();
  const rows = await db.aiMessage.findMany({
    where: {
      conversationId: { in: [...conversationIds] },
      conversation: { is: { userId } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, role: true, isFinal: true, conversationId: true },
  });
  const lastByConversation = new Map<string, StoredLastMessage>();
  for (const row of rows) {
    // Ascending order means each overwrite keeps the LAST row per
    // conversation.
    lastByConversation.set(row.conversationId, {
      conversationId: row.conversationId,
      messageId: row.id,
      role: row.role,
      isFinal: row.isFinal,
    });
  }
  return [...lastByConversation.values()];
}

// ---------------------------------------------------------------------------
// Delete (Phase 10.24)
// ---------------------------------------------------------------------------

/**
 * Delete a user-owned conversation atomically (Phase 10.24).
 *
 * A single ownership-scoped `deleteMany` (`where: { id, userId }`) is one
 * atomic SQL statement; on failure nothing is deleted and on success the
 * schema's existing ON DELETE CASCADE FK relations remove every dependent
 * row — the transcript `ai_messages`, conversation-scoped file/version
 * references (`ai_file_references`), and conversation-scoped actions
 * (`ai_actions`) — so no orphaned message or partial state can remain.
 *
 * Ownership is enforced by the delete predicate: a conversation whose
 * `userId` differs, OR that does not exist, deletes nothing and throws
 * `AgentConversationNotFoundError` — both are deliberately indistinguishable.
 *
 * NO file rows are ever touched: `fileId`/`versionId` values stored in the
 * transcript are metadata references only, never deletion targets.
 */
export async function deleteAgentConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  const db = getDatabase();
  const result = await db.aiConversation.deleteMany({
    where: { id: conversationId, userId },
  });
  if (result.count === 0) {
    throw new AgentConversationNotFoundError();
  }
}

/**
 * Replay stored transcript rows into a `ConversationState`. Pure — no I/O —
 * so it is directly unit-testable. A stored `user` row starts a new turn, a
 * stored `assistant` row without `is_final` is replaying `recordProviderTurn`
 * (+ its `tool_results` as `recordToolResults`), and an `is_final` row ends
 * the transcript. Each step runs through the Phase 10.6 validation, so
 * malformed stored data throws `AgentConversationCorruptError`.
 */
export function reconstructConversationState(
  maxToolRounds: number,
  stored: readonly StoredMessage[],
): ConversationState {
  let state: ConversationState | undefined;
  for (const message of [...stored].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (message.role === "user") {
      state = createConversationState({ instruction: message.content, maxToolRounds });
      continue;
    }
    if (message.role !== "assistant") continue;
    if (state === undefined) {
      throw new AgentConversationCorruptError(
        "Assistant message recorded before any user instruction.",
      );
    }
    state = replayAssistantMessage(state, message);
  }
  if (state === undefined) {
    throw new AgentConversationCorruptError(
      "Stored transcript has no user instruction to start the turn.",
    );
  }
  return state;
}

function replayAssistantMessage(state: ConversationState, message: StoredMessage): ConversationState {
  try {
    if (message.isFinal) {
      return finalizeConversation(state, message.content);
    }
    const toolCalls = message.toolCalls ?? undefined;
    const next = recordProviderTurn(state, {
      text: message.content.length > 0 ? message.content : undefined,
      toolCalls,
    });
    if (message.toolResults !== null && message.toolResults !== undefined) {
      if (!Array.isArray(message.toolResults)) {
        throw new TypeError("Stored tool results must be an array.");
      }
      const restored = message.toolResults.map(restoreToolResultError);
      return recordToolResults(next, restored);
    }
    return next;
  } catch (error) {
    if (error instanceof AgentConversationCorruptError) throw error;
    throw new AgentConversationCorruptError(
      "Stored conversation data is malformed or inconsistent.",
      error,
    );
  }
}

/**
 * Promote a serialized `ToolError` (`ok: false` results) back to a real
 * `ToolError` instance so loaded results match the Phase 10.6 contract.
 * Leaves every other value untouched.
 */
function restoreToolResultError(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (record.ok !== false) return raw;
  const error = record.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return raw;
  const serialized = error as Record<string, unknown>;
  if (typeof serialized.code !== "string" || typeof serialized.category !== "string") return raw;
  return {
    ...record,
    error: new ToolError(
      serialized.category as ToolErrorCategory,
      serialized.code,
      typeof serialized.message === "string" ? serialized.message : "",
    ),
  };
}

// ---------------------------------------------------------------------------
// Rename conversation title (Phase 10.25)
// ---------------------------------------------------------------------------

/** Stable success response for a title-only rename. */
export interface AiConversationRenameResult {
  id: string;
  title: string;
  updatedAt: string;
}

/**
 * Rename ONE conversation owned by `userId`. Ownership is verified inside the
 * same transaction that writes — a foreign owner cannot rename a conversation.
 *
 * Only the `title` column is modified; userId, timestamps (except updatedAt),
 * messages, tool calls/results, and provider information are untouched.
 *
 * @throws `AgentConversationNotFoundError` when the conversation does not
 *         exist for `userId` (indistinguishable from foreign ownership).
 */
export async function renameAgentConversation(
  userId: string,
  conversationId: string,
  newTitle: string,
): Promise<AiConversationRenameResult> {
  return await getDatabase().$transaction(async (tx) => {
    const owned = await tx.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (owned === null) throw new AgentConversationNotFoundError();
    await tx.aiConversation.update({
      where: { id: conversationId },
      data: { title: newTitle },
    });
    await bumpUpdatedAt(tx, conversationId);

    const conversation = await tx.aiConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, title: true, updatedAt: true },
    });
    if (conversation === null) {
      throw new AgentConversationNotFoundError();
    }
    if (conversation.title === null) {
      throw new AgentConversationNotFoundError();
    }
    return {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Archive / unarchive conversation (Phase 10.26B)
// ---------------------------------------------------------------------------

/** Stable success response for an archive/unarchive title-free write. */
export interface AiConversationArchiveResult {
  id: string;
  title: string | null;
  archivedAt: Date | null;
}

/**
 * Archive ONE conversation owned by `userId` (Phase 10.26B): set its
 * `archived_at` to the current timestamp. Idempotent — archiving an already
 * archived conversation is a safe no-op success.
 *
 * Ownership is enforced by the update predicate (`where: { id, userId }`): a
 * conversation whose owner differs, OR that does not exist, updates nothing and
 * throws `AgentConversationNotFoundError` — both are deliberately
 * indistinguishable. Only the `archived_at` column (and the maintained
 * `updated_at`) is touched; messages, tool data, file/version references,
 * title, and ownership are never modified.
 *
 * @throws `AgentConversationNotFoundError` when the conversation does not exist
 *         for `userId` (indistinguishable from foreign ownership).
 */
export async function archiveAgentConversation(
  userId: string,
  conversationId: string,
  now: Date,
): Promise<AiConversationArchiveResult> {
  const db = getDatabase();
  const updated = await db.aiConversation.updateMany({
    where: { id: conversationId, userId },
    data: { archivedAt: now, updatedAt: now },
  });
  if (updated.count === 0) {
    throw new AgentConversationNotFoundError();
  }
  const conversation = await db.aiConversation.findFirstOrThrow({
    where: { id: conversationId, userId },
    select: { id: true, title: true, archivedAt: true },
  });
  return {
    id: conversation.id,
    title: conversation.title,
    archivedAt: conversation.archivedAt,
  };
}

/**
 * Unarchive ONE conversation owned by `userId` (Phase 10.26B): clear its
 * `archived_at` back to `NULL`. Idempotent — unarchiving an already-active
 * conversation is a safe no-op success.
 *
 * Ownership is enforced by the update predicate (`where: { id, userId }`); a
 * foreign OR missing conversation is indistinguishable and both throw
 * `AgentConversationNotFoundError`. Only the `archived_at` column (and the
 * maintained `updated_at`) is touched; no other state changes.
 *
 * @throws `AgentConversationNotFoundError` when the conversation does not exist
 *         for `userId` (indistinguishable from foreign ownership).
 */
export async function unarchiveAgentConversation(
  userId: string,
  conversationId: string,
  now: Date,
): Promise<AiConversationArchiveResult> {
  const db = getDatabase();
  const updated = await db.aiConversation.updateMany({
    where: { id: conversationId, userId },
    data: { archivedAt: null, updatedAt: now },
  });
  if (updated.count === 0) {
    throw new AgentConversationNotFoundError();
  }
  const conversation = await db.aiConversation.findFirstOrThrow({
    where: { id: conversationId, userId },
    select: { id: true, title: true, archivedAt: true },
  });
  return {
    id: conversation.id,
    title: conversation.title,
    archivedAt: conversation.archivedAt,
  };
}
