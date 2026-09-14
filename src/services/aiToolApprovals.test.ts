/**
 * AI tool-approval CONTRACT tests (Phase 10.28B).
 *
 * The repository is mocked (only the two persistence functions); the REAL
 * `ToolRegistry` and real argument validation run, so these tests exercise the
 * contract's gates end to end without a database:
 *
 *   1. createAiToolApproval validation: userId/ids/expiry/toolName shape,
 *      registered-tool check (unknown → error), approval-gate check (a tool
 *      not marked `requiresApproval` is never approvable), and arguments
 *      validated against the tool's input schema.
 *   2. approve/reject delegate the EXACT explicit decision to the repository.
 *   3. Repository errors (duplicate / not-found / already-resolved / expired)
 *      propagate unchanged.
 *   4. Executable guard: only `approved` + inside-window approvals are
 *      executable; pending/rejected/expired and elapsed windows are not, and
 *      an elapsed approval is refused at the execution gate too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../tools/registry.js";
import { ToolPermission } from "../tools/types.js";
import { registerReadTools } from "../tools/definitions/readTools.js";
import {
  ToolApprovalAlreadyResolvedError,
  ToolApprovalDecision,
  ToolApprovalDuplicateError,
  ToolApprovalExpiredError,
  ToolApprovalInvalidArgumentsError,
  ToolApprovalNotExecutableError,
  ToolApprovalNotFoundError,
  ToolApprovalNotRequiredError,
  ToolApprovalStatus,
  ToolApprovalUnknownToolError,
  ToolApprovalValidationError,
  approveAiToolApproval,
  assertToolApprovalExecutable,
  createAiToolApproval,
  isToolApprovalExecutable,
  rejectAiToolApproval,
  type CreateAiToolApprovalRequest,
  type ToolApprovalRecord,
} from "./aiToolApprovals.js";

const mocks = vi.hoisted(() => ({
  createToolApproval: vi.fn(),
  resolveToolApproval: vi.fn(),
}));

vi.mock("../database/repositories/aiToolApprovals.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../database/repositories/aiToolApprovals.js")>();
  return {
    ...actual,
    createToolApproval: mocks.createToolApproval,
    resolveToolApproval: mocks.resolveToolApproval,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONVERSATION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MESSAGE = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const APPROVAL = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const NOW = new Date("2026-09-09T10:00:00.000Z");
const EXPIRES = new Date("2026-09-09T11:00:00.000Z");
const AFTER_EXPIRY = new Date("2026-09-09T12:00:00.000Z");

/** Registry with the four real read tools (NOT approval-gated) plus a gated
 *  write tool whose schema declares the fields used by the tests. */
function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registry.register({
    name: "delete_file",
    description: "Permanently delete a file.",
    permission: ToolPermission.Destructive,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to delete." },
        permanent: { type: "boolean", description: "Skip the trash." },
      },
      required: ["path"],
    },
  });
  return registry;
}

function baseRequest(): CreateAiToolApprovalRequest {
  return {
    userId: ALICE,
    conversationId: CONVERSATION,
    messageId: MESSAGE,
    toolName: "delete_file",
    arguments: { path: "/reports/old.txt", permanent: true },
    expiresAt: EXPIRES,
    now: NOW,
  };
}

function pendingRecord(overrides: Partial<ToolApprovalRecord> = {}): ToolApprovalRecord {
  return {
    id: APPROVAL,
    userId: ALICE,
    conversationId: CONVERSATION,
    messageId: MESSAGE,
    toolName: "delete_file",
    arguments: { path: "/reports/old.txt" },
    status: ToolApprovalStatus.Pending,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: EXPIRES,
    decidedAt: null,
    ...overrides,
  };
}

describe("aiToolApprovals contract", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = makeRegistry();
    mocks.createToolApproval.mockReset();
    mocks.resolveToolApproval.mockReset();
  });

  describe("createAiToolApproval", () => {
    it("creates a pending approval once the request validates", async () => {
      const record = pendingRecord();
      mocks.createToolApproval.mockResolvedValue(record);

      const created = await createAiToolApproval(baseRequest(), { registry });

      expect(created.id).toBe(APPROVAL);
      expect(mocks.createToolApproval).toHaveBeenCalledWith({
        userId: ALICE,
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        toolName: "delete_file",
        arguments: { path: "/reports/old.txt", permanent: true },
        expiresAt: EXPIRES,
        now: NOW,
      });
    });

    it.each([
      ["userId", { ...baseRequest(), userId: "" }],
      ["conversationId", { ...baseRequest(), conversationId: "not-a-uuid" }],
      ["messageId", { ...baseRequest(), messageId: 42 }],
      ["toolName", { ...baseRequest(), toolName: "" }],
      ["expiresAt", { ...baseRequest(), expiresAt: "2026-09-09" }],
      ["expiresAt not in the future", { ...baseRequest(), expiresAt: NOW }],
    ])("rejects a malformed %s before touching the repository", async (_label, request) => {
      await expect(createAiToolApproval(request, { registry })).rejects.toBeInstanceOf(
        ToolApprovalValidationError,
      );
      expect(mocks.createToolApproval).not.toHaveBeenCalled();
    });

    it("rejects a tool that is not registered", async () => {
      const request = baseRequest();
      request.toolName = "write_file";

      await expect(createAiToolApproval(request, { registry })).rejects.toBeInstanceOf(
        ToolApprovalUnknownToolError,
      );
      expect(mocks.createToolApproval).not.toHaveBeenCalled();
    });

    it("rejects a tool that does not require approval (read tools stay ungated)", async () => {
      const request = baseRequest();
      request.toolName = "read_file";

      const error = await createAiToolApproval(request, { registry }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ToolApprovalNotRequiredError);
      expect(mocks.createToolApproval).not.toHaveBeenCalled();
    });

    it("rejects arguments that are not a JSON object", async () => {
      const request = baseRequest();
      request.arguments = ["/reports/old.txt"];

      await expect(createAiToolApproval(request, { registry })).rejects.toBeInstanceOf(
        ToolApprovalInvalidArgumentsError,
      );
      expect(mocks.createToolApproval).not.toHaveBeenCalled();
    });

    it("rejects arguments that are missing a required field", async () => {
      const request = baseRequest();
      request.arguments = { permanent: true };

      await expect(createAiToolApproval(request, { registry })).rejects.toBeInstanceOf(
        ToolApprovalInvalidArgumentsError,
      );
      expect(mocks.createToolApproval).not.toHaveBeenCalled();
    });

    it("rejects arguments whose declared fields have the wrong type", async () => {
      const request = baseRequest();
      request.arguments = { path: "/reports/old.txt", permanent: "yes" };

      await expect(createAiToolApproval(request, { registry })).rejects.toBeInstanceOf(
        ToolApprovalInvalidArgumentsError,
      );
      expect(mocks.createToolApproval).not.toHaveBeenCalled();
    });

    it("propagates a repository duplicate error unchanged", async () => {
      const duplicate = new ToolApprovalDuplicateError(MESSAGE, "delete_file");
      mocks.createToolApproval.mockRejectedValue(duplicate);

      await expect(createAiToolApproval(baseRequest(), { registry })).rejects.toBe(duplicate);
    });
  });

  describe("approveAiToolApproval / rejectAiToolApproval", () => {
    it("approves with the explicit approve decision", async () => {
      const record = pendingRecord({ status: ToolApprovalStatus.Approved });
      mocks.resolveToolApproval.mockResolvedValue(record);

      const resolved = await approveAiToolApproval(ALICE, APPROVAL, NOW);

      expect(resolved.status).toBe(ToolApprovalStatus.Approved);
      expect(mocks.resolveToolApproval).toHaveBeenCalledWith(
        ALICE,
        APPROVAL,
        ToolApprovalDecision.Approve,
        NOW,
      );
    });

    it("rejects with the explicit reject decision", async () => {
      const record = pendingRecord({ status: ToolApprovalStatus.Rejected });
      mocks.resolveToolApproval.mockResolvedValue(record);

      const resolved = await rejectAiToolApproval(ALICE, APPROVAL, NOW);

      expect(resolved.status).toBe(ToolApprovalStatus.Rejected);
      expect(mocks.resolveToolApproval).toHaveBeenCalledWith(
        ALICE,
        APPROVAL,
        ToolApprovalDecision.Reject,
        NOW,
      );
    });

    it("rejects a malformed approval id before touching the repository", async () => {
      await expect(approveAiToolApproval(ALICE, "nope", NOW)).rejects.toBeInstanceOf(
        ToolApprovalValidationError,
      );
      await expect(rejectAiToolApproval("", APPROVAL, NOW)).rejects.toBeInstanceOf(
        ToolApprovalValidationError,
      );
      expect(mocks.resolveToolApproval).not.toHaveBeenCalled();
    });

    it("propagates not-found, already-resolved, and expired repository errors unchanged", async () => {
      for (const error of [
        new ToolApprovalNotFoundError(),
        new ToolApprovalAlreadyResolvedError(ToolApprovalStatus.Rejected),
        new ToolApprovalExpiredError(),
      ]) {
        mocks.resolveToolApproval.mockRejectedValue(error);
        await expect(approveAiToolApproval(ALICE, APPROVAL, NOW)).rejects.toBe(error);
      }
    });
  });

  describe("executable guard", () => {
    it("is executable only when approved and strictly inside the window", () => {
      expect(
        isToolApprovalExecutable(
          pendingRecord({ status: ToolApprovalStatus.Approved }),
          NOW,
        ),
      ).toBe(true);
      expect(
        isToolApprovalExecutable(
          pendingRecord({ status: ToolApprovalStatus.Pending }),
          NOW,
        ),
      ).toBe(false);
      expect(
        isToolApprovalExecutable(
          pendingRecord({ status: ToolApprovalStatus.Rejected }),
          NOW,
        ),
      ).toBe(false);
      expect(
        isToolApprovalExecutable(
          pendingRecord({ status: ToolApprovalStatus.Expired }),
          NOW,
        ),
      ).toBe(false);
    });

    it("is never executable at or after the expiry instant", () => {
      const approved = pendingRecord({ status: ToolApprovalStatus.Approved });
      expect(isToolApprovalExecutable(approved, EXPIRES)).toBe(false);
      expect(isToolApprovalExecutable(approved, AFTER_EXPIRY)).toBe(false);
    });

    it("refuses a not-approved approval at the execution gate", () => {
      expect(() =>
        assertToolApprovalExecutable(pendingRecord({ status: ToolApprovalStatus.Pending }), NOW),
      ).toThrow(ToolApprovalNotExecutableError);
      expect(() =>
        assertToolApprovalExecutable(pendingRecord({ status: ToolApprovalStatus.Rejected }), NOW),
      ).toThrow(ToolApprovalNotExecutableError);
      expect(() =>
        assertToolApprovalExecutable(pendingRecord({ status: ToolApprovalStatus.Expired }), NOW),
      ).toThrow(ToolApprovalNotExecutableError);
    });

    it("refuses an approved-but-elapsed approval at the execution gate", () => {
      expect(() =>
        assertToolApprovalExecutable(
          pendingRecord({ status: ToolApprovalStatus.Approved }),
          AFTER_EXPIRY,
        ),
      ).toThrow(ToolApprovalExpiredError);
    });
  });
});