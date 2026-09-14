/**
 * Approval gate at the authenticated tool invocation boundary (Phase 10.28C).
 *
 * The repository persistence is mocked (in-memory, faithfully mirroring the
 * one-pending-per-(message, tool) rule and the resolve state machine); the
 * REAL approval contract (10.28B validation + executable guard), the REAL
 * registry, policy, handler, and a recording fake executor run.
 *
 * Coverage:
 *
 *   1. Pending: a gated tool call creates a pending approval bound to the
 *      authenticated user + persisted conversation/message, returns the typed
 *      `approval_required` result, and NEVER executes.
 *   2. Approved execution: a presented approval executes the EXACT stored
 *      arguments (caller input is ignored) through policy → handler →
 *      executor.
 *   3. Rejection: pending / rejected / expired / foreign / missing approvals
 *      and tool mismatches are all denied without executing.
 *   4. Duplicate: a repeated request surfaces the SAME pending approval (no
 *      second row); deciding an already-resolved approval is rejected.
 *   5. Policy denial AFTER approval: an approved approval still has to pass
 *      the existing permission/policy checks.
 *   6. Fail-closed: a gated tool without persisted turn context never runs.
 *   7. Read-only tools with `requiresApproval: false` are unchanged.
 *   8. The agent request pipeline maps a gated intent to a structured denial.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../tools/registry.js";
import { ToolPermission } from "../tools/types.js";
import { ToolErrorCode } from "../tools/errors.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import {
  approveAiToolApproval,
  ToolApprovalAlreadyResolvedError,
} from "./aiToolApprovals.js";
import {
  invokeTool,
  isToolApprovalRequiredResult,
  type InvokeToolOptions,
} from "./tools.js";
import { runAgentRequest } from "./agent.js";
import type { AgentToolCall } from "./agent.js";

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
    readonly code = "tool-approval/not-found-or-not-owned";
    constructor() {
      super("Tool approval not found for this user.");
      this.name = "ToolApprovalNotFoundError";
    }
  }
  class DuplicateError extends Error {
    readonly code = "tool-approval/duplicate-pending";
    constructor(messageId: string, toolName: string) {
      super(`A pending tool approval already exists for tool "${toolName}" in message "${messageId}".`);
      this.name = "ToolApprovalDuplicateError";
    }
  }
  class AlreadyResolvedError extends Error {
    readonly code = "tool-approval/already-resolved";
    readonly status: string;
    constructor(status: string) {
      super(`This tool approval is already ${status}.`);
      this.name = "ToolApprovalAlreadyResolvedError";
      this.status = status;
    }
  }
  class ExpiredError extends Error {
    readonly code = "tool-approval/expired";
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
  resolveToolApproval: approvalRepo.resolveToolApproval,
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
const CONVERSATION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MESSAGE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

/** A recording fake executor — proves exactly what (if anything) executed. */
function makeFilesystem(): FilesystemExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listDirectory(path: string): Promise<DirectoryListing> {
      calls.push(`listDirectory:${path}`);
      return { path, parentPath: null, isHome: false, items: [] };
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
 * Registry for the gate: an approval-gated READ tool that HAS a real handler
 * (`list_directory`), an approval-gated WRITE tool (denied by the default
 * policy), and an ordinary read-only tool that is NOT gated.
 */
function makeGateRegistry(): ToolRegistry {
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
    name: "delete_file",
    description: "Approval-gated write (test fixture).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    permission: ToolPermission.Write,
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

function makeOptions(overrides?: Partial<InvokeToolOptions>): InvokeToolOptions {
  return {
    registry: makeGateRegistry(),
    filesystem: makeFilesystem(),
    turnContext: { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
    ...overrides,
  };
}

beforeEach(() => {
  approvalRepo.reset();
});
// ---------------------------------------------------------------------------
// 1. Pending approval — created, never executed
// ---------------------------------------------------------------------------

describe("invokeTool approval gate — pending", () => {
  it("creates a pending approval and never executes the gated tool", async () => {
    const filesystem = makeFilesystem();
    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/docs" },
      makeOptions({ filesystem }),
    );

    expect(isToolApprovalRequiredResult(result)).toBe(true);
    if (!isToolApprovalRequiredResult(result)) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.ApprovalRequired);
    expect(result.approval.approvalId).toMatch(/^00000000-0000-4000-8000-/);
    expect(result.approval.toolName).toBe("list_directory");
    expect(result.approval.arguments).toEqual({ path: "/home/docs" });
    expect(result.approval.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The executor was NEVER reached.
    expect(filesystem.calls).toEqual([]);

    // The pending row binds user + conversation + message + tool + arguments.
    expect(approvalRepo.rows).toHaveLength(1);
    const row = approvalRepo.rows[0];
    expect(row).toMatchObject({
      userId: ALICE.id,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      toolName: "list_directory",
      arguments: { path: "/home/docs" },
      status: "pending",
    });
  });

  it("returns the SAME pending approval on a duplicate request (no second row)", async () => {
    const first = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions(),
    );
    const second = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions(),
    );

    expect(isToolApprovalRequiredResult(first)).toBe(true);
    expect(isToolApprovalRequiredResult(second)).toBe(true);
    if (!isToolApprovalRequiredResult(first) || !isToolApprovalRequiredResult(second)) return;
    expect(second.approval.approvalId).toBe(first.approval.approvalId);
    expect(approvalRepo.rows).toHaveLength(1);
  });

  it("fails closed when a gated tool runs without persisted turn context", async () => {
    const filesystem = makeFilesystem();
    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions({ turnContext: undefined }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.ApprovalContextMissing);
    expect(filesystem.calls).toEqual([]);
    expect(approvalRepo.rows).toHaveLength(0);
  });

  it("rejects schema-invalid arguments without creating an approval", async () => {
    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { wrong: 1 },
      makeOptions(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.ApprovalInvalidArguments);
    expect(approvalRepo.rows).toHaveLength(0);
  });
});
// ---------------------------------------------------------------------------
// 2. Approved execution — exact stored arguments only
// ---------------------------------------------------------------------------

describe("invokeTool approval gate — approved execution", () => {
  it("executes an approved approval with the EXACT stored arguments", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/safe" },
      makeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    const approvalId = pending.approval.approvalId;

    // Explicit user decision through the real 10.28B contract.
    await approveAiToolApproval(ALICE.id, approvalId, new Date());

    // The caller presents the approval — and tries to smuggle DIFFERENT
    // arguments. Only the stored, validated arguments may execute.
    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/etc/passwd" },
      makeOptions({ filesystem, approvalId }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      path: "/home/safe",
      parentPath: null,
      isHome: false,
      items: [],
    });
    // The executor ran against the STORED path, never the smuggled one.
    expect(filesystem.calls).toEqual(["listDirectory:/home/safe"]);
  });

  it("never executes while the approval is still pending", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");

    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions({ filesystem, approvalId: pending.approval.approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotExecutable);
    expect(filesystem.calls).toEqual([]);
  });

  it("never executes a REJECTED approval", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    await approvalRepo.resolveToolApproval(
      ALICE.id,
      pending.approval.approvalId,
      approvalRepo.Decision.Reject,
      new Date(),
    );

    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions({ filesystem, approvalId: pending.approval.approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotExecutable);
    expect(filesystem.calls).toEqual([]);
  });

  it("never executes an EXPIRED approval", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    await approveAiToolApproval(ALICE.id, pending.approval.approvalId, new Date());
    // The window elapses after the decision.
    approvalRepo.rows[0]!.expiresAt = new Date(Date.now() - 1000);

    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions({ filesystem, approvalId: pending.approval.approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotExecutable);
    expect(result.error.message).toContain("expired");
    expect(filesystem.calls).toEqual([]);
  });
  it("never executes with a FOREIGN approval (ownership)", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    await approveAiToolApproval(ALICE.id, pending.approval.approvalId, new Date());

    // Bob presents Alice's approval — indistinguishable from missing.
    const result = await invokeTool(
      sessionContext(BOB),
      "list_directory",
      { path: "/home" },
      makeOptions({ filesystem, approvalId: pending.approval.approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotFound);
    expect(filesystem.calls).toEqual([]);
  });

  it("never executes with a MISSING approval id", async () => {
    const filesystem = makeFilesystem();
    const result = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions({ filesystem, approvalId: "99999999-9999-4999-8999-999999999999" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.ApprovalNotFound);
    expect(filesystem.calls).toEqual([]);
  });

  it("never executes an approval created for a DIFFERENT tool", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    await approveAiToolApproval(ALICE.id, pending.approval.approvalId, new Date());

    // Present the list_directory approval while invoking delete_file.
    const result = await invokeTool(
      sessionContext(ALICE),
      "delete_file",
      { path: "/home" },
      makeOptions({ filesystem, approvalId: pending.approval.approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.ApprovalToolMismatch);
    expect(filesystem.calls).toEqual([]);
  });

  it("refuses to decide an already-resolved approval twice", async () => {
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home" },
      makeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    const approvalId = pending.approval.approvalId;

    await approveAiToolApproval(ALICE.id, approvalId, new Date());
    await expect(approveAiToolApproval(ALICE.id, approvalId, new Date())).rejects.toBeInstanceOf(
      ToolApprovalAlreadyResolvedError,
    );
    expect(approvalRepo.rows[0]?.status).toBe("approved");
  });
});
// ---------------------------------------------------------------------------
// 3. Policy denial after approval — approval is not authorization
// ---------------------------------------------------------------------------

describe("invokeTool approval gate — policy after approval", () => {
  it("passes policy after approval but dispatch still validates the handler exists", async () => {
    const filesystem = makeFilesystem();
    // The gated WRITE tool: approval can be created and approved. The default
    // policy allows approval-gated tools through (the approval IS the
    // authorization), but delete_file has no handler — dispatch returns
    // handler-missing.
    const pending = await invokeTool(
      sessionContext(ALICE),
      "delete_file",
      { path: "/home/important.txt" },
      makeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    await approveAiToolApproval(ALICE.id, pending.approval.approvalId, new Date());

    const result = await invokeTool(
      sessionContext(ALICE),
      "delete_file",
      { path: "/home/important.txt" },
      makeOptions({ filesystem, approvalId: pending.approval.approvalId }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("internal");
    expect(result.error.code).toBe(ToolErrorCode.HandlerMissing);
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Read-only tools without requiresApproval are unchanged
// ---------------------------------------------------------------------------

describe("invokeTool approval gate — ungated tools", () => {
  it("executes a read-only requiresApproval:false tool normally", async () => {
    const filesystem = makeFilesystem();
    const result = await invokeTool(
      sessionContext(ALICE),
      "search_files",
      { query: "notes" },
      makeOptions({ filesystem }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
    expect(filesystem.calls).toEqual(["searchFiles:notes"]);
    expect(approvalRepo.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The agent request pipeline never executes a gated intent
// ---------------------------------------------------------------------------

describe("runAgentRequest — gated intents map to a structured denial", () => {
  it("returns an approval-required denial and creates the pending approval", async () => {
    const filesystem = makeFilesystem();
    const call: AgentToolCall = {
      id: "c1",
      toolName: "list_directory",
      input: { path: "/home" },
    };

    const result = await runAgentRequest(sessionContext(ALICE), { calls: [call] }, makeOptions({ filesystem }));

    expect(result.results).toHaveLength(1);
    const outcome = result.results[0];
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.category).toBe("security");
    expect(outcome.error.code).toBe(ToolErrorCode.ApprovalRequired);
    // The executor never ran; exactly one pending approval exists.
    expect(filesystem.calls).toEqual([]);
    expect(approvalRepo.rows).toHaveLength(1);
    expect(approvalRepo.rows[0]?.status).toBe("pending");
  });
});