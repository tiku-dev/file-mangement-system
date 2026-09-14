/**
 * Persistent agent turn orchestration (Phase 10.8).
 *
 * The smallest service that connects the Phase 10.3–10.7 agent layers into
 * one durable, authenticated turn:
 *
 *   1. AUTH + CONTEXT (Phase 10.5): `buildAgentContext` pre-flights the
 *      authenticated user (fail closed — no provider call without a valid
 *      session) and filters the offered tool metadata down to registered
 *      tools. The authenticated user id is the ownership key for everything
 *      the repository writes or reads.
 *   2. LOAD OR CREATE (Phase 10.7): an existing conversation is loaded with
 *      ownership enforced (a foreign/missing conversation is rejected), and
 *      its persisted round bound becomes this turn's bound; otherwise a new
 *      conversation is prepared for creation.
 *   3. LOOP (Phase 10.4): the existing bounded tool loop runs against the
 *      provider with the registered tool metadata. An `onRound` observer
 *      (additive, added in 10.8) records each executed round's transcript in
 *      memory, and a `prepareRound` hook (added in 10.28C-prep) EAGERLY
 *      persists — BEFORE each round's intents execute — the conversation
 *      (first round) and the round's assistant/tool-call message, so a REAL
 *      persisted `messageId` exists for every tool execution. That context is
 *      threaded through `routeAgentResponse` → `invokeTool` and bound to each
 *      tool's `ToolExecutionContext` (the Phase 10.28 approval boundary).
 *   4. STATE (Phase 10.6): the transcript is replayed through the immutable
 *      `ConversationState` transitions — the same validators persistence
 *      uses — to produce the updated state (and to reject malformed rounds
 *      before the final write).
 *   5. PERSIST (Phase 10.7 repository): a tool round's eager rows are the
 *      REAL committed transcript; on success `completeAgentTurn` attaches the
 *      results + final reply in ONE transaction. Text-only turns (no tools)
 *      keep the original all-or-nothing `persistAgentTurn` write. If the turn
 *      fails AFTER eager persistence, `cancelAgentTurn` compensates so NO
 *      partial turn state remains: a new conversation is deleted (cascade),
 *      a resumed conversation loses exactly this turn's messages.
 *
 * Phase 10.20 — COMPOSED STACK INTEGRATION: production turns obtain the
 * provider through the composed provider stack (`ComposedProviderStack` from
 * the composition root), NOT by constructing/selecting a single provider.
 * The stack is injected once (created at startup via
 * `composeDefaultProviderStack()`) and its `provider` facade — the fallback
 * layer that owns credential rotation and health/cooldown — runs EVERY round
 * of the turn. Fallback, rotation, and cooldown are therefore REAL for
 * production turns yet fully transparent to the Agent: it still receives
 * only plain `AgentResponse` values, never provider ids, credentials,
 * fallback state, or cooldown state.
 *
 * Phase 10.30 — APPROVAL RESUME: `resumeApprovalId` continues an interrupted
 * turn after a tool approval decision. The approved approval is resolved with
 * ownership enforced, asserted executable, executed ONCE through the existing
 * `invokeTool` gate → policy → handler → executor pipeline (only the EXACT
 * stored arguments run), consumed so it can never be replayed, and recorded
 * as this turn's first (pre-run) tool round. The bounded loop then continues
 * from round one against the approval's own conversation with the executed
 * result as seeded context — bounded by the conversation's persisted
 * `maxToolRounds`, never beyond it. Rejected, expired, foreign, or
 * already-consumed approvals are rejected before anything runs, and the tool
 * round's result is persisted through the same eager transcript +
 * `completeAgentTurn` path as every other round.
 *
 * Design rules:
 *
 *   - OWNERSHIP EVERYWHERE: load, eager-write, complete, and cancel are keyed
 *     by the authenticated user derived from the session, never from
 *     provider/request data. A foreign conversation looks identical to a
 *     missing one.
 *   - NO DUPLICATED LOOP: this service does not re-implement the bounded loop;
 *     it observes it, persists what it records, and threads persisted
 *     turn context through the loop's existing invocation path.
 *   - NO POLICY BYPASS: tool execution stays in the Phase 10.2/9.8
 *     `invokeTool()` pipeline on every round; the only new data is the
 *     persisted `conversationId`/`messageId` bound to the execution context.
 *   - CONSISTENCY: eager rows are committed ONLY for tool rounds that will
 *     actually execute; a failure afterwards compensates via `cancelAgentTurn`
 *     so a failed turn leaves no partial state (a hard process crash in that
 *     window can leave a valid-but-incomplete transcript — never corrupt —
 *     which the load/reconstruct path handles and a later turn appends to).
 *   - NO I/O OUTSIDE THE REPOSITORY: the service performs no direct Prisma
 *     access; it goes through the Phase 10.7 repository functions.
 */
import { AppError } from "../core/errors.js";
import type { AgentProvider } from "./provider.js";
import type { ToolDefinition } from "../tools/types.js";
import type { InvokeToolOptions, ToolApprovalRequestInfo } from "./tools.js";
import { invokeTool } from "./tools.js";
import type { AgentToolCall, AgentToolResult } from "./agent.js";
import type { RawToolInput } from "../tools/handlers/handler.js";
import {
  ToolApprovalNotFoundError,
  assertToolApprovalExecutable,
  consumeToolApproval,
  getToolApproval,
  type ToolApprovalRecord,
} from "./aiToolApprovals.js";
import { buildAgentContext } from "./agentContext.js";
import { runAgentLoop, type AgentLoopRound } from "./agentLoop.js";
import type { ComposedProviderStack } from "./providerComposition.js";
import {
  createConversationState,
  finalizeConversation,
  recordProviderTurn,
  recordToolResults,
  type ConversationState,
} from "./conversation.js";
import {
  AgentConversationNotFoundError,
  appendAgentTurnRoundMessage,
  beginAgentTurn,
  cancelAgentTurn,
  completeAgentTurn,
  loadAgentConversationState,
  persistAgentTurn,
  type AgentTurnRecord,
} from "../database/repositories/agentConversations.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistentTurnInput {
  /** Resume this conversation (ownership enforced). Omit to create a new one. */
  conversationId?: string;
  /** The user's instruction for this turn. */
  instruction: string;
  /** Optional display title for newly created conversations. */
  title?: string;
  /**
   * Resume mode (Phase 10.30): the id of an OWNED, `approved` tool approval to
   * execute. The turn executes ONLY the approval's exact stored arguments
   * through the existing gate → policy → handler → executor pipeline, records
   * the result as this turn's first round, consumes the approval so it can
   * never be replayed, then continues the bounded loop against the approval's
   * OWN conversation (the conversation's persisted round bound applies). A
   * supplied `conversationId` must match the approval's conversation.
   */
  resumeApprovalId?: string;
}

export interface PersistentTurnOptions extends InvokeToolOptions {
  /**
   * The composed provider stack whose `provider` facade drives the turn
   * (Phase 10.20 preferred integration). Every round runs through the stack's
   * fallback layer — credential rotation and health/cooldown included — all
   * transparent to the Agent. Mutually exclusive with `provider`.
   */
  stack?: ComposedProviderStack;
  /**
   * A ready `AgentProvider` facade (retained for back-compat / direct tests).
   * Mutually exclusive with `stack`; exactly one of the two is required.
   */
  provider?: AgentProvider;
  /** Candidate tool metadata; filtered to registered tools before use. */
  tools: readonly ToolDefinition[];
  /** Loop bound used when creating a new conversation. Default 1. */
  maxToolRounds?: number;
}

export interface PersistentTurnResult {
  /** The conversation id (existing or newly created). */
  conversationId: string;
  /** True when a new conversation was created for this turn. */
  created: boolean;
  /** The updated, fully persisted conversation state (Phase 10.6). */
  state: ConversationState;
  /**
   * Pending approval metadata collected during this turn (Phase 10.29).
   * Empty when no tools required approval. Safe metadata only: approval id,
   * tool name, validated arguments, and expiry — no raw file contents or
   * provider output.
   */
  pendingApprovals: readonly ToolApprovalRequestInfo[];
}

/**
 * Resolve the turn's provider facade. Exactly one of `stack` (preferred,
 * Phase 10.20) or `provider` must be supplied — the composed stack's
 * `provider` is the fallback facade that owns rotation + health/cooldown.
 *
 * @throws `TypeError` when neither or both sources are supplied.
 */
function resolveTurnProvider(options: PersistentTurnOptions): AgentProvider {
  const hasStack = options.stack !== undefined;
  const hasProvider = options.provider !== undefined;
  if (hasStack === hasProvider) {
    throw new TypeError(
      "runPersistentTurn requires exactly one provider source: `stack` " +
        "(composed provider stack) or `provider` (AgentProvider).",
    );
  }
  const provider = options.stack?.provider ?? options.provider;
  if (provider === undefined) {
    throw new TypeError("runPersistentTurn has no usable provider facade.");
  }
  return provider;
}

/** Map a loop-observed round into the repository's persist shape. */
function toTurnRecord(round: AgentLoopRound): AgentTurnRecord {
  return {
    ...(round.text !== undefined ? { text: round.text } : {}),
    toolCalls: round.toolCalls,
    toolResults: round.results,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Run one durable agent turn for the authenticated session user.
 *
 * Persistence ORDER (Phase 10.28C-prep):
 *
 *   - Text-only turns (the provider never requests tools) are persisted the
 *     original way: the ENTIRE turn atomically via `persistAgentTurn`; a
 *     failure before that write leaves nothing.
 *   - Tool turns EAGERLY persist round by round: `beginAgentTurn` (first
 *     round: conversation + instruction + round message committed) and
 *     `appendAgentTurnRoundMessage` (later rounds) run BEFORE that round's
 *     intents execute, so every tool execution has a REAL persisted
 *     `conversationId` + `messageId` bound to its `ToolExecutionContext`.
 *     `completeAgentTurn` then attaches the results + final reply in ONE
 *     transaction.
 *   - If the turn fails after eager persistence, `cancelAgentTurn`
 *     compensates: a new conversation is deleted, or a resumed conversation
 *     loses exactly this turn's messages — no partial turn state remains.
 *
 * @throws `AppError.unauthorized()` when `c` has no valid session (fail
 *         closed before the provider is contacted).
 * @throws `AgentConversationNotFoundError` when `conversationId` is not
 *         owned by the authenticated user (or does not exist).
 * @throws `ToolApprovalNotFoundError` (resume mode) when `resumeApprovalId`
 *         is not owned by the authenticated user (indistinguishable from
 *         missing), or references a conversation the user cannot load.
 * @throws `ToolApprovalNotExecutableError` / `ToolApprovalExpiredError`
 *         (resume mode) when the approval is not `approved` / its window has
 *         elapsed — nothing is executed. The same guards prevent replay of an
 *         already-consumed approval.
 * @throws `AppError.badRequest` (resume mode) when a supplied
 *         `conversationId` does not match the approval's own conversation.
 * @throws `ProviderError` when the provider fails — the eager rows of the
 *         failed turn are compensated away (nothing new remains).
 * @throws `AgentLoopError` when the provider requests tools past the bound —
 *         the skipped tools are never executed and the executed rounds'
 *         eager rows are compensated away.
 * @throws `TypeError` on malformed provider rounds / missing final text —
 *         any eager rows are compensated away.
 */
export async function runPersistentTurn(
  c: { get: (key: string) => unknown },
  input: PersistentTurnInput,
  options: PersistentTurnOptions,
): Promise<PersistentTurnResult> {
  // 0. Resolve the provider facade BEFORE any work: either the composed
  //    provider stack (Phase 10.20 production integration) or a ready
  //    AgentProvider. Exactly one source is allowed.
  const provider = resolveTurnProvider(options);

  // 1. Auth pre-flight + provider-visible context (Phase 10.5). Fails closed,
  //    filters registered tools, and validates the instruction.
  const { auth, context } = buildAgentContext({
    instruction: input.instruction,
    tools: options.tools,
    registry: options.registry,
    user: c.get("user"),
  });
  const userId = auth.user.id;
  if (userId.length === 0) {
    throw AppError.unauthorized();
  }

  // 2. Load an existing conversation (ownership enforced) to inherit its
  //    round bound; otherwise the input/default bound applies. In resume mode
  //    (Phase 10.30) the conversation is the approved approval's OWN one: the
  //    approval is resolved with ownership enforced, its stored operation is
  //    asserted executable NOW (rejected/expired/foreign/consumed never run),
  //    and its conversation's persisted bound becomes this turn's bound.
  let bound: number | undefined;
  let resumeRecord: ToolApprovalRecord | undefined;
  if (input.resumeApprovalId !== undefined) {
    const record = await getToolApproval(userId, input.resumeApprovalId);
    if (record === null) {
      throw new ToolApprovalNotFoundError();
    }
    if (input.conversationId !== undefined && record.conversationId !== input.conversationId) {
      throw AppError.badRequest("The approval belongs to a different conversation.");
    }
    assertToolApprovalExecutable(record, new Date());
    const resumedConversation = await loadAgentConversationState(userId, record.conversationId);
    if (resumedConversation === null) {
      throw new ToolApprovalNotFoundError();
    }
    bound = resumedConversation.maxToolRounds;
    resumeRecord = record;
  } else if (input.conversationId !== undefined) {
    const loaded = await loadAgentConversationState(userId, input.conversationId);
    if (loaded === null) {
      throw new AgentConversationNotFoundError();
    }
    bound = loaded.maxToolRounds;
  }
  const maxToolRounds = bound ?? options.maxToolRounds ?? 1;

  // Eager-persistence state (Phase 10.28C-prep). `engaged` turns true once
  // the FIRST tool round is committed; from then on every failure path
  // compensates so no partial turn state survives.
  let engaged = false;
  let conversationId: string | undefined;
  let created = false;
  let instructionMessageId: string | undefined;
  let currentSlot: { messageId: string; toolResults?: readonly AgentToolResult[] } | undefined;
  const roundSlots: { messageId: string; toolResults?: readonly AgentToolResult[] }[] = [];

  try {
    // 3. Resume mode (Phase 10.30): BEFORE the loop, execute the approved
    //    approval exactly once, consume it so it can never be replayed, and
    //    record it as this turn's first (pre-run) tool round. Execution stays
    //    in the unchanged `invokeTool` gate → policy → handler → executor
    //    pipeline; ONLY the approval's exact stored arguments run (the caller
    //    supplies none here). The result is fed to the provider as seeded
    //    context and counted against the conversation's round bound.
    const observed: AgentLoopRound[] = [];
    let resumeSeeded: { toolResult: AgentToolResult; approvedCall: AgentToolCall } | undefined;
    if (resumeRecord !== undefined) {
      const executed = await invokeTool(
        c,
        resumeRecord.toolName,
        {},
        {
          registry: options.registry,
          filesystem: options.filesystem,
          ...(options.policy !== undefined ? { policy: options.policy } : {}),
          turnContext: {
            conversationId: resumeRecord.conversationId,
            messageId: resumeRecord.messageId,
          },
          approvalId: resumeRecord.id,
        },
      );
      const toolResult: AgentToolResult = executed.ok
        ? { ok: true, callId: resumeRecord.id, data: executed.data }
        : { ok: false, callId: resumeRecord.id, error: executed.error };
      const approvedCall: AgentToolCall = {
        id: resumeRecord.id,
        toolName: resumeRecord.toolName,
        input: resumeRecord.arguments as RawToolInput,
      };
      // Seal the spent approval so it can never authorize a second execution.
      // Best-effort: the execution has already happened, so a consume failure
      // must not mask the executed turn (single-request semantics — the same
      // non-transactional caveat the Phase 10.28C approval gate has).
      try {
        await consumeToolApproval(userId, resumeRecord.id, new Date());
      } catch {
        // A concurrent decision cannot undo an execution that already ran.
      }
      const begun = await beginAgentTurn({
        userId,
        conversationId: resumeRecord.conversationId,
        instruction: context.instruction,
        maxToolRounds,
        toolCalls: [approvedCall],
      });
      conversationId = begun.conversationId;
      created = begun.created;
      instructionMessageId = begun.instructionMessageId;
      engaged = true;
      currentSlot = { messageId: begun.messageId, toolResults: [toolResult] };
      roundSlots.push(currentSlot);
      observed.push({
        text: undefined,
        toolCalls: [approvedCall],
        results: [toolResult],
        toolRounds: 1,
      });
      resumeSeeded = { toolResult, approvedCall };
    }

    const output = await runAgentLoop(c, context.instruction, {
      provider,
      tools: context.tools,
      registry: options.registry,
      filesystem: options.filesystem,
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      maxToolRounds,
      ...(resumeSeeded !== undefined
        ? { initialToolResults: [resumeSeeded.toolResult], initialToolRounds: 1 }
        : {}),
      onRound: (round) => {
        observed.push(round);
        // The loop calls prepareRound → execute → onRound in strict order,
        // so `currentSlot` is exactly the round just executed.
        if (currentSlot !== undefined) currentSlot.toolResults = round.results;
        currentSlot = undefined;
      },
      prepareRound: async (response) => {
        if (engaged) {
          const appended = await appendAgentTurnRoundMessage({
            userId,
            conversationId: conversationId as string,
            ...(response.text !== undefined ? { text: response.text } : {}),
            toolCalls: response.toolCalls ?? [],
          });
          currentSlot = { messageId: appended.messageId };
          roundSlots.push(currentSlot);
          return {
            conversationId: conversationId as string,
            messageId: appended.messageId,
          };
        }
        const begun = await beginAgentTurn({
          userId,
          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
          instruction: context.instruction,
          maxToolRounds,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(response.text !== undefined ? { text: response.text } : {}),
          toolCalls: response.toolCalls ?? [],
        });
        conversationId = begun.conversationId;
        created = begun.created;
        instructionMessageId = begun.instructionMessageId;
        engaged = true;
        currentSlot = { messageId: begun.messageId };
        roundSlots.push(currentSlot);
        return {
          conversationId: begun.conversationId,
          messageId: begun.messageId,
        };
      },
    });
    const rounds = observed.map(toTurnRecord);

    // Phase 10.29: collect pending approval metadata from the agent loop.
    // This is safe metadata only — approval id, tool name, validated args,
    // and expiry — no raw file contents or provider output.
    const turnPendingApprovals = output.pendingApprovals;

    // 4. Replay the transcript through the Phase 10.6 transitions. This both
    //    validates (reusing the same guards persistence uses) and produces the
    //    updated state returned to the caller.
    let state = createConversationState({
      instruction: context.instruction,
      maxToolRounds,
    });
    for (const round of rounds) {
      state = recordProviderTurn(state, {
        text: round.text,
        toolCalls: round.toolCalls,
      });
      if (round.toolResults !== undefined) {
        state = recordToolResults(state, round.toolResults);
      }
    }
    state = finalizeConversation(state, output.text ?? undefined);

    // 5. Persist the final result. Tool turns: attach each round's
    //    tool_results to its eager message and append the is_final reply in
    //    ONE transaction (ownership re-verified inside). Text-only turns keep
    //    the original all-or-nothing `persistAgentTurn` write.
    if (engaged) {
      await completeAgentTurn({
        userId,
        conversationId: conversationId as string,
        rounds: roundSlots.map((slot) => ({
          messageId: slot.messageId,
          toolResults: slot.toolResults ?? [],
        })),
        finalText: state.finalText ?? "",
      });
      return {
        conversationId: conversationId as string,
        created,
        state,
        pendingApprovals: turnPendingApprovals,
      };
    }

    const persisted = await persistAgentTurn({
      userId,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      instruction: context.instruction,
      maxToolRounds,
      ...(input.title !== undefined ? { title: input.title } : {}),
      rounds,
      finalText: state.finalText ?? "",
    });

    return {
      conversationId: persisted.id,
      created: persisted.created,
      state,
      pendingApprovals: turnPendingApprovals,
    };
  } catch (error) {
    // 6. Compensation: a failed turn that already committed eager rows must
    //    not leave partial state. A new conversation is deleted (cascade); a
    //    resumed conversation loses exactly this turn's messages. The
    //    compensation is best-effort so the ORIGINAL error always governs.
    if (engaged) {
      try {
        await cancelAgentTurn({
          userId,
          conversationId: conversationId as string,
          created,
          messageIds: [
            ...(instructionMessageId !== undefined ? [instructionMessageId] : []),
            ...roundSlots.map((slot) => slot.messageId),
          ],
        });
      } catch {
        // A failed compensation (e.g. the database is down) cannot mask the
        // original failure. The rows left behind are valid-but-incomplete
        // transcript entries — never corrupt — and a later successful turn
        // appends to the conversation normally.
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Composed-stack runtime binding (Phase 10.20)
// ---------------------------------------------------------------------------

/**
 * Persistent-turn runtime options bound to a COMPOSED provider stack. The
 * stack is created once at startup (via `composeDefaultProviderStack()`) and
 * drives every turn; setting `provider` is intentionally disallowed here so
 * production wiring cannot bypass the multi-provider system.
 */
export type PersistentTurnStackOptions = Omit<PersistentTurnOptions, "provider" | "stack"> & {
  /** The composed provider stack whose facade runs each turn's rounds. */
  stack: ComposedProviderStack;
};

/**
 * A persistent-turn runtime pre-bound to one composed provider stack. This is
 * the production integration point (Phase 10.20): the app composes the
 * configured multi-provider stack ONCE and routes every authenticated turn
 * through it. Fallback, credential rotation, and health/cooldown then run
 * inside the stack, transparently to the Agent.
 */
export interface PersistentAgentTurnRuntime {
  /**
   * Run one durable, authenticated turn through the bound composed stack.
   * @throws `AppError.unauthorized()` / `AgentConversationNotFoundError` /
   *         `ProviderError` / `AgentLoopError` exactly as `runPersistentTurn`.
   */
  run(
    c: { get: (key: string) => unknown },
    input: PersistentTurnInput,
  ): Promise<PersistentTurnResult>;
}

/**
 * Bind a composed provider stack to the persistent-turn service. The stack's
 * `provider` facade is obtained at runtime by the service itself — the caller
 * never hands it a bare single-provider construction.
 *
 * @throws `TypeError` when the caller accidentally supplies `provider` as well
 *         (the stack is the only allowed source here).
 */
export function createPersistentTurnRuntime(
  options: PersistentTurnStackOptions,
): PersistentAgentTurnRuntime {
  const { stack } = options;
  if ((options as PersistentTurnOptions).provider !== undefined) {
    throw new TypeError(
      "createPersistentTurnRuntime only accepts a composed `stack`; " +
        "a bare `provider` cannot be combined with it.",
    );
  }
  return {
    async run(c, input) {
      return runPersistentTurn(c, input, { ...options, stack });
    },
  };
}
