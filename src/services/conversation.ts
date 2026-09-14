/**
 * Agent conversation / state contract (Phase 10.6).
 *
 * The smallest typed, immutable model of an agent conversation or turn. It
 * captures everything a bounded tool loop observes as it progresses:
 *
 *   - the user's instruction
 *   - provider messages/responses (text and/or tool-call intents)
 *   - structured tool-call RESULTS
 *   - the final agent response (text), once the loop has ended
 *   - the current turn/round state (how many tool rounds ran, the bound)
 *
 * Design rules:
 *
 *   - PROVIDER-INDEPENDENT: messages are typed around the existing Phase
 *     10.1 `AgentToolCall` / `AgentToolResult` shapes and plain text — no
 *     provider/LLM vocabulary.
 *   - IMMUTABLE: every value is frozen and read-only. State changes only
 *     through the explicit transition functions below, each of which
 *     returns a NEW state and NEVER mutates the input.
 *   - IDENTITY SEPARATE: conversation data carries no user identity or
 *     security context. That lives on the auth channel (Phase 10.5), never
 *     inside this model.
 *   - UNTRUSTED INPUT GATED: provider text/tool-calls are admitted only via
 *     validated transition functions. Malformed shapes throw `TypeError`
 *     and cannot corrupt state.
 *   - LOOP WITHOUT DUPLICATION: this module holds the current round state
 *     and the round-limit check (`remainingToolRounds`, `isComplete`). The
 *     actual provider/`invokeTool()` driving lives in the existing bounded
 *     loop — the state is a faithful record of it, not a re-implementation.
 *
 * This module performs no I/O, calls no provider, executes no tools, and
 * never bypasses `invokeTool()`/policy.
 */
import type { AgentToolCall, AgentToolResult } from "./agent.js";

// ---------------------------------------------------------------------------
// Message model
// ---------------------------------------------------------------------------

/** A role-typed entry in the conversation transcript. */
export type AgentMessage = ProviderMessage | FinalMessage;

/**
 * A provider response within a round: the provider either produced free-form
 * `text`, requested `toolCalls`, or both. Committed one round at a time.
 */
export interface ProviderMessage {
  readonly kind: "provider";
  /** Optional free-form reply from the provider. */
  readonly text?: string;
  /**
   * Tool-call intents the provider requested this round, in the Phase 10.1
   * `AgentToolCall` shape. Never executed from here — routed elsewhere.
   */
  readonly toolCalls?: readonly AgentToolCall[];
}

/**
 * The final agent response: terminal free-form text returned once the loop
 * stopped (final text or the round limit). Ends the transcript.
 */
export interface FinalMessage {
  readonly kind: "final";
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------------

/** The immutable, provider-independent state of an agent conversation/turn. */
export interface ConversationState {
  /** The user's instruction / goal (immutable for the life of the turn). */
  readonly instruction: string;
  /** Ordered transcript of provider rounds, then an optional final message. */
  readonly messages: readonly AgentMessage[];
  /** Structured tool results accumulated across executed rounds. */
  readonly toolResults: readonly AgentToolResult[];
  /** The final agent response, once the conversation has completed. */
  readonly finalText?: string;
  /** Number of tool-execution rounds completed so far. */
  readonly toolRounds: number;
  /** Strict maximum number of tool-execution rounds (the loop bound). */
  readonly maxToolRounds: number;
}

/**
 * Options for creating a fresh conversation state. `maxToolRounds` mirrors
 * the bounded loop's server-side bound, so the state can report round
 * progress without re-implementing the loop.
 */
export interface ConversationOptions {
  /** The user's instruction. */
  instruction: string;
  /** Strict maximum number of tool-execution rounds. Positive integer. */
  maxToolRounds: number;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value) as Readonly<T>;
}

function assertInstruction(instruction: unknown): string {
  if (typeof instruction !== "string" || instruction.length === 0) {
    throw new TypeError("instruction must be a non-empty string.");
  }
  return instruction;
}

function assertMaxToolRounds(maxToolRounds: unknown): number {
  if (!Number.isInteger(maxToolRounds) || (maxToolRounds as number) < 1) {
    throw new TypeError("maxToolRounds must be a positive integer.");
  }
  return maxToolRounds as number;
}

function assertText(text: unknown): string | undefined {
  if (text === undefined) return undefined;
  if (typeof text !== "string") {
    throw new TypeError("provider text must be a string.");
  }
  if (text.length === 0) {
    throw new TypeError("provider text must be a non-empty string when present.");
  }
  return text;
}

/**
 * Validate an untrusted value into the `AgentToolCall[]` contract. Returns a
 * frozen copy, or `undefined` when the value is `undefined`. Throws `TypeError`
 * on any malformed shape. Exported so persistence can gate writes with the same
 * validators the state transitions use.
 */
export function validateToolCalls(toolCalls: unknown): readonly AgentToolCall[] | undefined {
  return assertToolCalls(toolCalls);
}

function assertToolCalls(toolCalls: unknown): readonly AgentToolCall[] | undefined {
  if (toolCalls === undefined) return undefined;
  if (!Array.isArray(toolCalls)) {
    throw new TypeError("provider toolCalls must be an array.");
  }
  for (const call of toolCalls) {
    if (
      typeof call !== "object" ||
      call === null ||
      Array.isArray(call) ||
      typeof (call as { id?: unknown }).id !== "string" ||
      (call as { id: string }).id.length === 0 ||
      typeof (call as { toolName?: unknown }).toolName !== "string" ||
      (call as { toolName: string }).toolName.length === 0
    ) {
      throw new TypeError("provider toolCalls must be valid AgentToolCall shapes.");
    }
    const input = (call as { input?: unknown }).input;
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input)
    ) {
      throw new TypeError("provider toolCalls input must be a JSON object.");
    }
  }
  return freeze(toolCalls as AgentToolCall[]) as readonly AgentToolCall[];
}

/**
 * Validate an untrusted value into the `AgentToolResult[]` contract. Returns a
 * frozen copy. Throws `TypeError` on any malformed shape. Exported so
 * persistence can gate writes with the same validators the state transitions
 * use.
 */
export function validateToolResults(results: unknown): readonly AgentToolResult[] {
  return assertToolResults(results);
}

function assertToolResults(results: unknown): readonly AgentToolResult[] {
  if (!Array.isArray(results)) {
    throw new TypeError("tool results must be an array.");
  }
  for (const result of results) {
    if (
      typeof result !== "object" ||
      result === null ||
      typeof (result as { callId?: unknown }).callId !== "string"
    ) {
      throw new TypeError("tool results must be valid AgentToolResult shapes.");
    }
  }
  return freeze(results as AgentToolResult[]) as readonly AgentToolResult[];
}

/**
 * Create a fresh conversation state around a user instruction.
 *
 * Mirrors the bounded loop's fail-closed bound: `maxToolRounds` must be a
 * positive integer. A brand-new conversation has no messages, no results,
 * and zero completed tool rounds.
 *
 * @throws `TypeError` when `instruction` is empty or `maxToolRounds` invalid.
 */
export function createConversationState(
  options: ConversationOptions,
): ConversationState {
  return freeze({
    instruction: assertInstruction(options.instruction),
    messages: freeze([]),
    toolResults: freeze([]),
    toolRounds: 0,
    maxToolRounds: assertMaxToolRounds(options.maxToolRounds),
  });
}

/**
 * Record a provider round: append the provider's text + tool-call intents
 * to the transcript as a `ProviderMessage`. Returns a NEW state. Does not
 * execute anything and does not advance the round count (that happens with
 * its tool results).
 *
 * Rejects a conversation that has already completed.
 *
 * @throws `Error` when the state is already complete (final message present).
 * @throws `TypeError` on malformed provider text/tool-calls.
 */
export function recordProviderTurn(
  state: ConversationState,
  response: { text?: unknown; toolCalls?: unknown },
): ConversationState {
  if (state.finalText !== undefined) {
    throw new Error("Cannot record a provider turn after the conversation is complete.");
  }
  const text = assertText(response.text);
  const toolCalls = assertToolCalls(response.toolCalls);
  if (text === undefined && toolCalls === undefined) {
    throw new TypeError("A provider turn must include text or toolCalls.");
  }

  const message: ProviderMessage = freeze({
    kind: "provider",
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  });

  return freeze({
    ...state,
    messages: freeze([...state.messages, message]),
  });
}

/**
 * Record the structured results of the just-executed round and advance the
 * round counter by one. Returns a NEW state.
 *
 * @throws `Error` when the state is already complete.
 * @throws `TypeError` on malformed tool results.
 */
export function recordToolResults(
  state: ConversationState,
  toolResultsInput: unknown,
): ConversationState {
  if (state.finalText !== undefined) {
    throw new Error("Cannot record tool results after the conversation is complete.");
  }
  const results = assertToolResults(toolResultsInput);
  return freeze({
    ...state,
    toolResults: freeze([...state.toolResults, ...results]),
    toolRounds: state.toolRounds + 1,
  });
}

/**
 * Complete the conversation with a final text response (the terminal agent
 * reply). Returns a NEW state with the final message appended and
 * `finalText` set.
 *
 * @throws `Error` when the state is already complete.
 * @throws `TypeError` when `text` is not a non-empty string.
 */
export function finalizeConversation(
  state: ConversationState,
  text: unknown,
): ConversationState {
  if (state.finalText !== undefined) {
    throw new Error("The conversation is already complete.");
  }
  const finalText = assertText(text);
  if (finalText === undefined) {
    throw new TypeError("final text must be a non-empty string.");
  }
  return freeze({
    ...state,
    finalText,
    messages: freeze([...state.messages, freeze({ kind: "final", text: finalText })]),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Whether the conversation has completed (a final message is present).
 */
export function isConversationComplete(state: ConversationState): boolean {
  return state.finalText !== undefined;
}

/**
 * How many more tool rounds are allowed by the bound before the loop would
 * stop. Zero or negative means the bound is exhausted.
 */
export function remainingToolRounds(state: ConversationState): number {
  return state.maxToolRounds - state.toolRounds;
}
