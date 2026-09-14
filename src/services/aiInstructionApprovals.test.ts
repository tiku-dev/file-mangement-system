/**
 * Phase 10.29 — the authenticated AI instruction flow surfaces the approval
 * lifecycle (Phase 10.28D → 10.28C → 10.28B → 10.28A) end-to-end.
 *
 * The instruction flow (`runAiInstructionWithRuntime` → `runPersistentTurn` →
 * bounded loop → `routeAgentResponse` → `runAgentRequest` → `invokeTool`) runs
 * REAL, with a scripted FAKE provider (no AI, no keys, no network) and a real
 * registry + handlers + recording fake executor. Both repository seams are
 * mocked: the approval persistence (in-memory, faithfully mirroring the
 * one-pending-per-(message, tool) rule and the resolve state machine) and the
 * agent-conversation persistence used for the eager turn transcript.
 *
 * Coverage:
 *
 *   1. PENDING (flow): a gated tool request inside an authenticated instruction
 *      creates ONE pending approval bound to the authenticated user and the
 *      PERSISTED conversation/message of the turn, NEVER executes (executor
 *      untouched), and the typed instruction response surfaces SAFE metadata
 *      only (approval id, tool name, validated arguments, expiry). The
 *      provider sees the calibrated `approval_required` denial as round
 *      feedback, and the transcript is persisted exactly like any tool round.
 *   2. APPROVED CONTINUATION (boundary): once the pending approval is approved
 *      through the existing contract, presenting it executes the EXACT stored
 *      arguments through policy → handler → executor with the flow's own
 *      persisted context — the caller's smuggled input never runs.
 *   3. REJECTED / EXPIRED: a rejected or expired approval is never executable
 *      — the executor is never reached.
 *   4. OWNERSHIP: another authenticated user's instruction flow cannot see,
 *      reuse, or run against a peer's pending approval — it gets its own
 *      pending row, and the peer's approval is never surfaced or executed.
 *   5. REGRESSION: ungated tools are unchanged — normal flows execute with no
 *      approvals created and `pendingApprovals: []` in the response.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../tools/registry.js";
import { ToolPermission } from "../tools/types.js";
import { ToolErrorCode } from "../tools/errors.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import { readToolDefinitions } from "../tools/definitions/readTools.js";
import type { AgentToolCall } from "./agent.js";
import type { AgentProvider, AgentProviderRequest, AgentResponse } from "./provider.js";
import { approveAiToolApproval } from "./aiToolApprovals.js";
import { invokeTool, isToolApprovalRequiredResult, type InvokeToolOptions } from "./tools.js";
import { runAiInstructionWithRuntime } from "./aiInstructions.js";
import {
  runPersistentTurn,
  type PersistentAgentTurnRuntime,
  type PersistentTurnOptions,
} from "./persistentAgentTurn.js";

// ---------------------------------------------------------------------------
// In-memory approval repository (mirrors the one-pending rule + resolve state
// machine; the REAL contract validation and executable guard run).
// ---------------------------------------------------------------------------

const approvalRepo = vi.hoisted(() => {
  type Row = {
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
  };
  const Status = {
    Pending: "pending",
    Approved: "approved",
    Rejected: "rejected",
    Expired: "expired",
  } as const;
  const Decision = { Approve: "approved", Reject: "rejected" } as const;

  class NotFoundError extends Error {
    constructor() {
      super("Tool approval not found for this user.");
      this.name = "ToolApprovalNotFoundError";
    }
  }
  class DuplicateError extends Error {
    constructor(messageId: string, toolName: string) {
      super(
        `A pending tool approval already exists for tool "${toolName}" in message "${messageId}".`,
      );
      this.name = "ToolApprovalDuplicateError";
    }
  }
  class AlreadyResolvedError extends Error {
    readonly status: string;
    constructor(status: string) {
      super(`This tool approval is already ${status}.`);
      this.name = "ToolApprovalAlreadyResolvedError";
      this.status = status;
    }
  }
  class ExpiredError extends Error {
    constructor() {
      super("This tool approval has expired.");
      this.name = "ToolApprovalExpiredError";
    }
  }

  const rows: Row[] = [];
  let seq = 0;
  function reset(): void {
    rows.length = 0;
    seq = 0;
  }

  async function createToolApproval(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    toolName: string;
    arguments: unknown;
    expiresAt: Date;
    now: Date;
  }): Promise<Row> {
    const duplicate = rows.find(
      (r) =>
        r.messageId === input.messageId &&
        r.toolName === input.toolName &&
        r.status === Status.Pending,
    );
    if (duplicate !== undefined) {
      throw new DuplicateError(input.messageId, input.toolName);
    }
    seq += 1;
    const created: Row = {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      toolName: input.toolName,
      arguments: input.arguments,
      status: Status.Pending,
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: input.expiresAt,
      decidedAt: null,
    };
    rows.push(created);
    return created;
  }

  async function getToolApproval(userId: string, approvalId: string): Promise<Row | null> {
    return rows.find((r) => r.id === approvalId && r.userId === userId) ?? null;
  }

  async function getPendingToolApproval(
    userId: string,
    messageId: string,
    toolName: string,
  ): Promise<Row | null> {
    return (
      rows.find(
        (r) =>
          r.userId === userId &&
          r.messageId === messageId &&
          r.toolName === toolName &&
          r.status === Status.Pending,
      ) ?? null
    );
  }

  async function resolveToolApproval(
    userId: string,
    approvalId: string,
    decision: string,
    now: Date,
  ): Promise<Row> {
    const target = rows.find((r) => r.id === approvalId && r.userId === userId);
    if (target === undefined) throw new NotFoundError();
    if (target.status !== Status.Pending) throw new AlreadyResolvedError(target.status);
    if (now.getTime() >= target.expiresAt.getTime()) {
      target.status = Status.Expired;
      target.decidedAt = now;
      target.updatedAt = now;
      throw new ExpiredError();
    }
    target.status = decision;
    target.decidedAt = now;
    target.updatedAt = now;
    return target;
  }

  return {
    rows,
    reset,
    Status,
    Decision,
    NotFoundError,
    DuplicateError,
    AlreadyResolvedError,
    ExpiredError,
    createToolApproval,
    getToolApproval,
    getPendingToolApproval,
    resolveToolApproval,
  };
});

vi.mock("../database/repositories/aiToolApprovals.js", () => ({
  ToolApprovalStatus: approvalRepo.Status,
  ToolApprovalDecision: approvalRepo.Decision,
  ToolApprovalNotFoundError: approvalRepo.NotFoundError,
  ToolApprovalDuplicateError: approvalRepo.DuplicateError,
  ToolApprovalAlreadyResolvedError: approvalRepo.AlreadyResolvedError,
  ToolApprovalExpiredError: approvalRepo.ExpiredError,
  createToolApproval: approvalRepo.createToolApproval,
  getToolApproval: approvalRepo.getToolApproval,
  getPendingToolApproval: approvalRepo.getPendingToolApproval,
  listPendingToolApprovals: vi.fn(),
  resolveToolApproval: approvalRepo.resolveToolApproval,
}));

// ---------------------------------------------------------------------------
// Agent-conversation persistence (the eager turn transcript), as Phase 10.8.
// ---------------------------------------------------------------------------

const conversationMocks = vi.hoisted(() => ({
  loadAgentConversationState: vi.fn(),
  persistAgentTurn: vi.fn(),
  beginAgentTurn: vi.fn(),
  appendAgentTurnRoundMessage: vi.fn(),
  completeAgentTurn: vi.fn(),
  cancelAgentTurn: vi.fn(),
}));

vi.mock("../database/repositories/agentConversations.js", () => ({
  loadAgentConversationState: conversationMocks.loadAgentConversationState,
  persistAgentTurn: conversationMocks.persistAgentTurn,
  beginAgentTurn: conversationMocks.beginAgentTurn,
  appendAgentTurnRoundMessage: conversationMocks.appendAgentTurnRoundMessage,
  completeAgentTurn: conversationMocks.completeAgentTurn,
  cancelAgentTurn: conversationMocks.cancelAgentTurn,
  AgentConversationNotFoundError: class AgentConversationNotFoundError extends Error {
    constructor() {
      super("Agent conversation not found for this user.");
      this.name = "AgentConversationNotFoundError";
    }
  },
}));

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
const USER_ID = ALICE.id;

// Persisted ids the mocked eager-turn transcript returns. The approval
// CONTRACT validates that conversation/message ids are UUID-shaped, so the
// flow fixtures use real-looking UUIDs; the gate fixtures mirror them.
const CONVERSATION_ID = "55555555-5555-5555-5555-555555555555";
const MESSAGE_ID = "66666666-6666-6666-6666-666666666666";

function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

type Generate = AgentProvider["generate"];

function scriptedProvider(responses: Array<AgentResponse>): {
  generate: Generate;
  requests: AgentProviderRequest[];
} {
  const requests: AgentProviderRequest[] = [];
  const generate = vi.fn<Generate>().mockImplementation(async (request) => {
    requests.push(request);
    const response = responses[requests.length - 1];
    if (response === undefined) throw new Error("fake provider script exhausted");
    return response;
  });
  return { generate, requests };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

function homeListing(path: string): DirectoryListing {
  return { path, parentPath: null, isHome: false, items: [] };
}

/** A recording fake executor — proves exactly what (if anything) executed. */
function makeFilesystem(): FilesystemExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listDirectory(path: string): Promise<DirectoryListing> {
      calls.push(`listDirectory:${path}`);
      return homeListing(path);
    },
    async searchFiles(query: string) {
      calls.push(`searchFiles:${query}`);
      return [];
    },
    async getFileMetadata() {
      throw new Error("not used in this test");
    },
    async readFile() {
      throw new Error("not used in this test");
    },
    async moveFile() {
      throw new Error("not used in this test");
    },
  };
}

/**
 * A REGISTRY (and provider-visible tools) with one approval-gated READ tool
 * backed by a REAL handler (`list_directory`) and one ordinary ungated tool
 * (`search_files`) — mirroring the real tool surface modulo the gate flag.
 */
function makeGatedRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "list_directory",
    description: "Approval-gated directory listing (test fixture).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    permission: ToolPermission.Read,
    requiresApproval: true,
  });
  registry.register({
    name: "search_files",
    description: "Ordinary read-only tool (not gated).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    permission: ToolPermission.Read,
  });
  return registry;
}

/** The ungated baseline registry (regression coverage). */
function makePlainRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "list_directory",
    description: "Ordinary directory listing.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    permission: ToolPermission.Read,
  });
  registry.register({
    name: "search_files",
    description: "Ordinary read-only tool (not gated).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    permission: ToolPermission.Read,
  });
  return registry;
}

function makeInvokeOptions(overrides?: Partial<InvokeToolOptions>): InvokeToolOptions {
  return {
    registry: makeGatedRegistry(),
    filesystem: makeFilesystem(),
    turnContext: { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
    ...overrides,
  };
}

function makeRuntimeOptions(
  provider: AgentProvider,
  override?: {
    registry?: ToolRegistry;
    filesystem?: FilesystemExecutor;
    maxToolRounds?: number;
  },
): PersistentTurnOptions {
  return {
    provider,
    tools: readToolDefinitions,
    registry: override?.registry ?? makeGatedRegistry(),
    filesystem: override?.filesystem ?? makeFilesystem(),
    maxToolRounds: override?.maxToolRounds ?? 3,
  };
}

/** A real persistent-turn runtime bound to the given options (Phase 10.20 seam). */
function makeInstructionRuntime(options: PersistentTurnOptions): PersistentAgentTurnRuntime {
  return {
    async run(c, input) {
      return runPersistentTurn(c, input, options);
    },
  };
}

beforeEach(() => {
  approvalRepo.reset();
  vi.clearAllMocks();
  conversationMocks.loadAgentConversationState.mockReset();
  conversationMocks.persistAgentTurn
    .mockReset()
    .mockResolvedValue({ id: CONVERSATION_ID, created: true });
  conversationMocks.beginAgentTurn.mockReset().mockResolvedValue({
    conversationId: CONVERSATION_ID,
    created: true,
    instructionMessageId: "77777777-7777-4777-8777-777777777777",
    messageId: MESSAGE_ID,
  });
  conversationMocks.appendAgentTurnRoundMessage.mockReset().mockResolvedValue({
    messageId: "88888888-8888-4888-8888-888888888888",
  });
  conversationMocks.completeAgentTurn.mockReset().mockResolvedValue(undefined);
  conversationMocks.cancelAgentTurn.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. Pending approval inside an authenticated instruction flow
// ---------------------------------------------------------------------------

describe("instruction flow — a gated tool request is persisted as pending, never executed", () => {
  it("records the approval on the turn's OWNED conversation/message and surfaces safe metadata", async () => {
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([
      { toolCalls: [call("c1", "list_directory", { path: "/home/docs" })] },
      { text: "Done." },
    ]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "List my docs.",
    });

    // Safe, stable response shape: the approval surfaced via `pendingApprovals`.
    expect(response.conversationId).toBe(CONVERSATION_ID);
    expect(response.turn.toolRounds).toBe(1);
    expect(response.turn.finalText).toBe("Done.");
    // The structured denial is reduced to the usual safe { callId, ok } synopsis.
    expect(response.turn.toolResults).toEqual([{ callId: "c1", ok: false }]);

    // Safe metadata ONLY: approval id, tool name, validated arguments, expiry.
    expect(response.turn.pendingApprovals).toHaveLength(1);
    const surfaced = response.turn.pendingApprovals[0]!;
    expect(Object.keys(surfaced).sort()).toEqual(
      ["approvalId", "arguments", "expiresAt", "toolName"].sort(),
    );
    expect(surfaced.toolName).toBe("list_directory");
    expect(surfaced.arguments).toEqual({ path: "/home/docs" });
    expect(surfaced.expiresAt).toBeInstanceOf(Date);
    expect(surfaced.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The gated tool was NEVER executed.
    expect(filesystem.calls).toEqual([]);

    // Exactly ONE pending row, bound to the authenticated user + the persisted
    // conversation/message the turn eagerly committed.
    expect(approvalRepo.rows).toHaveLength(1);
    expect(approvalRepo.rows[0]).toMatchObject({
      id: surfaced.approvalId,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      toolName: "list_directory",
      arguments: { path: "/home/docs" },
      status: "pending",
    });

    // The provider's round-2 context shows the approval_required denial exactly
    // like any other tool result — it never sees credentials or file contents.
    const secondRequest = requests[1];
    expect(secondRequest?.toolResults).toHaveLength(1);
    const feedback = secondRequest?.toolResults?.[0];
    expect(feedback).toMatchObject({ ok: false, callId: "c1" });
    if (feedback !== undefined && !feedback.ok) {
      expect(feedback.error.category).toBe("security");
      expect(feedback.error.code).toBe(ToolErrorCode.ApprovalRequired);
    }

    // The turn is persisted as a normal tool round (eager transcript, single
    // completeAgentTurn transaction); no atomic-write fallback.
    expect(conversationMocks.beginAgentTurn).toHaveBeenCalledTimes(1);
    expect(conversationMocks.completeAgentTurn).toHaveBeenCalledTimes(1);
    expect(conversationMocks.persistAgentTurn).not.toHaveBeenCalled();
    expect(conversationMocks.cancelAgentTurn).not.toHaveBeenCalled();
  });

  it("returns the SAME pending approval for the same message + tool (no second row)", async () => {
    const { generate } = scriptedProvider([
      {
        toolCalls: [
          call("c1", "list_directory", { path: "/home/docs" }),
          call("c2", "list_directory", { path: "/home/docs" }),
        ],
      },
      { text: "Done." },
    ]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }));

    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "List my docs.",
    });

    // One round = one message: both intents surface the SAME pending approval,
    // and only ONE pending row is written — the second request is idempotent.
    expect(response.turn.pendingApprovals).toHaveLength(2);
    expect(response.turn.pendingApprovals[0]?.approvalId).toBe(
      response.turn.pendingApprovals[1]?.approvalId,
    );
    expect(approvalRepo.rows).toHaveLength(1);
    expect(approvalRepo.rows[0]?.messageId).toBe(MESSAGE_ID);
  });

  it("surfaces a clean pendingApprovals:[] (an empty array) on an ungated flow and executes normally", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([
      { toolCalls: [call("s", "search_files", { query: "notes" })] },
      { text: "Found none." },
    ]);
    const runtime = makeInstructionRuntime(
      makeRuntimeOptions({ generate }, { filesystem, registry: makePlainRegistry() }),
    );

    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Search notes.",
    });

    expect(response.turn.pendingApprovals).toEqual([]);
    expect(response.turn.toolResults).toEqual([{ callId: "s", ok: true }]);
    expect(filesystem.calls).toEqual(["searchFiles:notes"]);
    expect(approvalRepo.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Approved continuation — policy → handler → executor with the flow context
// ---------------------------------------------------------------------------

describe("instruction flow — an approved approval continues through the real pipeline", () => {
  it("executes the EXACT stored arguments (caller input ignored), using the flow's persisted context", async () => {
    const filesystem = makeFilesystem();

    // The instruction flow creates the pending approval against the turn's real
    // persisted context (registry with the gate flag and the flow's executor).
    await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/docs" },
      makeInvokeOptions({ filesystem }),
    );
    expect(approvalRepo.rows).toHaveLength(1);
    const approvalId = approvalRepo.rows[0]!.id;

    // Traditional explicit decision through the existing contract.
    await approveAiToolApproval(USER_ID, approvalId, new Date());
    expect(approvalRepo.rows[0]?.status).toBe("approved");

    // The caller presents the approval — and tries to smuggle different
    // arguments. Only the stored, validated arguments may execute, still
    // through the unchanged policy → handler → executor pipeline.
    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/etc/passwd" },
      makeInvokeOptions({ filesystem, approvalId }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(homeListing("/home/docs"));
    expect(filesystem.calls).toEqual(["listDirectory:/home/docs"]);
  });

  it("never executes while the approval is still pending", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeInvokeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending))
      return expect.unreachable("pending approval expected");

    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeInvokeOptions({ filesystem, approvalId: pending.approval.approvalId }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotExecutable);
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Rejected / expired approvals are never executable
// ---------------------------------------------------------------------------

describe("instruction flow — rejected and expired approvals never execute", () => {
  it("never executes a rejected approval", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/safe" },
      makeInvokeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    const approvalId = pending.approval.approvalId;

    await approvalRepo.resolveToolApproval(
      USER_ID,
      approvalId,
      approvalRepo.Decision.Reject,
      new Date(),
    );
    expect(approvalRepo.rows[0]?.status).toBe("rejected");

    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/safe" },
      makeInvokeOptions({ filesystem, approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotExecutable);
    expect(filesystem.calls).toEqual([]);
  });

  it("never executes an expired approval", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/safe" },
      makeInvokeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    const approvalId = pending.approval.approvalId;

    await approveAiToolApproval(USER_ID, approvalId, new Date());
    // The window elapses after the decision.
    approvalRepo.rows[0]!.expiresAt = new Date(Date.now() - 1000);

    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/safe" },
      makeInvokeOptions({ filesystem, approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotExecutable);
    expect(result.error.message).toContain("expired");
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Ownership — a peer's pending approval is neither visible nor executable
// ---------------------------------------------------------------------------

describe("instruction flow — ownership is the authenticated user", () => {
  it("another user's flow creates ITS OWN pending row and never executes against a peer's", async () => {
    const aliceRuntime = makeInstructionRuntime(
      makeRuntimeOptions({
        generate: scriptedProvider([
          { toolCalls: [call("c1", "list_directory", { path: "/alice/secret" })] },
          { text: "Waiting." },
        ]).generate,
      }),
    );
    const apples = await runAiInstructionWithRuntime(aliceRuntime, sessionContext(ALICE), {
      instruction: "List my secret folder.",
    });
    const aliceApprovalId = apples.turn.pendingApprovals[0]?.approvalId;
    expect(aliceApprovalId).toBeDefined();
    expect(approvalRepo.rows).toHaveLength(1);
    expect(approvalRepo.rows[0]?.userId).toBe(USER_ID);

    // Bob's own flow (a DIFFERENT persisted conversation/message).
    conversationMocks.beginAgentTurn.mockResolvedValue({
      conversationId: "99999999-9999-4999-8999-999999999999",
      created: true,
      instructionMessageId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      messageId: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const bobRuntime = makeInstructionRuntime(
      makeRuntimeOptions({
        generate: scriptedProvider([
          { toolCalls: [call("c1", "list_directory", { path: "/bob/reports" })] },
          { text: "Done" },
        ]).generate,
      }),
    );
    const bobResponse = await runAiInstructionWithRuntime(bobRuntime, sessionContext(BOB), {
      instruction: "List my reports.",
    });

    // Bob's turn surfaced Bob's OWN pending approval, never Alice's.
    expect(approvalRepo.rows).toHaveLength(2);
    const bobRow = approvalRepo.rows.find((row) => row.userId === BOB.id);
    expect(bobRow).toMatchObject({
      toolName: "list_directory",
      arguments: { path: "/bob/reports" },
      status: "pending",
    });
    expect(bobResponse.turn.pendingApprovals).toHaveLength(1);
    expect(bobResponse.turn.pendingApprovals[0]?.approvalId).toBe(bobRow?.id);
    expect(bobResponse.turn.pendingApprovals[0]?.approvalId).not.toBe(aliceApprovalId);
    // Both rows remain untouched by the peer's flow.
    expect(approvalRepo.rows.find((row) => row.id === aliceApprovalId)?.status).toBe("pending");
  });

  it("a peer presenting the approval on the invocation boundary is denied like missing", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/alice/private" },
      makeInvokeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    await approveAiToolApproval(USER_ID, pending.approval.approvalId, new Date());

    // Bob presents Alice's approved approval — indistinguishable from missing.
    const result = await invokeTool(
      sessionContext(BOB),
      "list_directory",
      { path: "/alice/private" },
      makeInvokeOptions({ filesystem, approvalId: pending.approval.approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotFound);
    expect(filesystem.calls).toEqual([]);
  });
});
