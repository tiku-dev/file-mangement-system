/**
 * AI agent orchestration contract tests (Phase 10.1).
 *
 * These tests prove the typed agent request/result contracts and that
 * every tool-call intent is routed through the EXISTING authenticated
 * invocation pipeline (`invokeTool` → registry → policy → handler →
 * executor). The provider-independent intent shape carries no AI
 * provider, LLM, or API-key coupling.
 *
 * Coverage:
 *
 *   1. Valid agent requests → intents routed and correlated results returned.
 *   2. Empty agent request → valid no-op.
 *   3. Invalid agent request shapes → rejected (badRequest).
 *   4. Invalid tool-call intents → rejected (badRequest).
 *   5. Unauthenticated session → runAgentRequest rejects (401).
 *   6. Policy preserved: permission denial and disabled users are denied.
 *   7. Request-supplied identity cannot influence the dispatched actor.
 */
import { describe, expect, it } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  ToolPermission,
  type ToolDefinition,
} from "../tools/types.js";
import { registerReadTools } from "../tools/definitions/readTools.js";
import { ToolErrorCode } from "../tools/errors.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import type { InvokeToolOptions } from "./tools.js";
import type { ToolExecutionContext, ToolPolicy } from "../tools/policy.js";
import { defaultToolPolicy } from "../tools/policy.js";
import {
  parseAgentRequest,
  runAgentRequest,
  type AgentRequest,
  type AgentToolCall,
} from "./agent.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

const PENDING_USER = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob Example",
  status: "pending",
};

/** A session-shaped context: `requireAuth` would have stamped the user. */
function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

/** A fake FilesystemExecutor that records calls (no Tauri/Rust). */
function makeFilesystem(): FilesystemExecutor & { calls: string[] } {
  const calls: string[] = [];
  const fake: FilesystemExecutor & { calls: string[] } = {
    calls,
    async listDirectory(path): Promise<DirectoryListing> {
      calls.push(`listDirectory:${path}`);
      return { path, parentPath: null, isHome: false, items: [] };
    },
    async searchFiles() {
      calls.push("searchFiles");
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
  return fake;
}

/** A registered, read-only tool registry wired like the app's would be. */
function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  return registry;
}

function makeOptions(
  registry: ToolRegistry,
  filesystem: FilesystemExecutor,
  policy?: ToolPolicy,
): InvokeToolOptions {
  return { registry, filesystem, policy };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

// ---------------------------------------------------------------------------
// 1. Valid agent requests — routed through invokeTool
// ---------------------------------------------------------------------------

describe("runAgentRequest — valid agent request", () => {
  it("routes each intent through the authenticated pipeline and returns correlated results", async () => {
    const filesystem = makeFilesystem();
    const request: AgentRequest = {
      id: "req-1",
      calls: [
        call("call-1", "list_directory", { path: "/home" }),
        call("call-2", "search_files", { query: "report" }),
      ],
    };

    const result = await runAgentRequest(
      sessionContext(ACTIVE_USER),
      request,
      makeOptions(makeRegistry(), filesystem),
    );

    expect(result.requestId).toBe("req-1");
    expect(result.results).toHaveLength(2);

    expect(result.results[0]).toEqual({
      ok: true,
      callId: "call-1",
      data: { path: "/home", parentPath: null, isHome: false, items: [] },
    });
    expect(result.results[1]).toEqual({ ok: true, callId: "call-2", data: [] });

    // Both intents really ran through the executor, in request order.
    expect(filesystem.calls).toEqual(["listDirectory:/home", "searchFiles"]);
  });

  it("executes intents in request order", async () => {
    const filesystem = makeFilesystem();
    const request: AgentRequest = {
      calls: [
        call("a", "search_files", { query: "first" }),
        call("b", "list_directory", { path: "/second" }),
      ],
    };
    await runAgentRequest(
      sessionContext(ACTIVE_USER),
      request,
      makeOptions(makeRegistry(), filesystem),
    );
    expect(filesystem.calls).toEqual(["searchFiles", "listDirectory:/second"]);
  });

  it("an empty calls array is a valid request that returns no results", async () => {
    const result = await runAgentRequest(
      sessionContext(ACTIVE_USER),
      { calls: [] },
      makeOptions(makeRegistry(), makeFilesystem()),
    );
    expect(result.requestId).toBeUndefined();
    expect(result.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. parseAgentRequest validation
// ---------------------------------------------------------------------------

describe("parseAgentRequest — invalid agent requests are rejected", () => {
  it("rejects non-object values", () => {
    for (const value of [null, undefined, "request", 42, ["calls"]]) {
      expect(() => parseAgentRequest(value)).toThrow(AppError);
    }
  });

  it("rejects a non-array or missing calls field", () => {
    expect(() => parseAgentRequest({})).toThrow(AppError);
    expect(() => parseAgentRequest({ calls: "nope" })).toThrow(AppError);
    expect(() => parseAgentRequest({ calls: {} })).toThrow(AppError);
  });

  it("rejects a bad request id when one is supplied", () => {
    expect(() => parseAgentRequest({ id: 42, calls: [] })).toThrow(AppError);
    expect(() => parseAgentRequest({ id: "", calls: [] })).toThrow(AppError);
  });

  it("rejects a call that is not an object", () => {
    expect(() => parseAgentRequest({ calls: [null, "x", 42, []] })).toThrow(AppError);
  });

  it("rejects a call without a non-empty string id", () => {
    expect(() =>
      parseAgentRequest({
        calls: [{ toolName: "list_directory", input: { path: "/" } }],
      }),
    ).toThrow(AppError);
    expect(() =>
      parseAgentRequest({
        calls: [{ id: "", toolName: "list_directory", input: { path: "/" } }],
      }),
    ).toThrow(AppError);
  });

  it("rejects a call with a missing or non-string toolName", () => {
    expect(() =>
      parseAgentRequest({
        calls: [{ id: "c1", input: { path: "/" } }],
      }),
    ).toThrow(AppError);
    expect(() =>
      parseAgentRequest({
        calls: [{ id: "c1", toolName: "", input: { path: "/" } }],
      }),
    ).toThrow(AppError);
  });

  it("rejects a call with a missing or non-object input", () => {
    expect(() =>
      parseAgentRequest({
        calls: [{ id: "c1", toolName: "list_directory" }],
      }),
    ).toThrow(AppError);
    expect(() =>
      parseAgentRequest({
        calls: [{ id: "c1", toolName: "list_directory", input: null }],
      }),
    ).toThrow(AppError);
    expect(() =>
      parseAgentRequest({
        calls: [{ id: "c1", toolName: "list_directory", input: "path" }],
      }),
    ).toThrow(AppError);
  });

  it("accepts and normalizes a valid request into the typed contract", () => {
    const parsed = parseAgentRequest({
      id: "req-9",
      calls: [{ id: "c1", toolName: "list_directory", input: { path: "/" } }],
    });
    expect(parsed).toEqual({
      id: "req-9",
      calls: [{ id: "c1", toolName: "list_directory", input: { path: "/" } }],
    });
  });

  it("does not accept identity fields at the request level", () => {
    expect(() =>
      parseAgentRequest({
        id: "req-10",
        userId: "attacker",
        calls: [{ id: "c1", toolName: "list_directory", input: { path: "/" } }],
      }),
    ).not.toThrow(AppError);
    // Extra fields are ignored — identity is established by the session only.
    const parsed = parseAgentRequest({
      userId: "attacker",
      email: "mallory@example.com",
      calls: [{ id: "c1", toolName: "list_directory", input: { path: "/" } }],
    });
    expect((parsed as unknown as Record<string, unknown>).userId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Tool-call routing through the authenticated invocation path
// ---------------------------------------------------------------------------

describe("runAgentRequest — authenticated routing", () => {
  it("rejects an unauthenticated session before any intent runs", async () => {
    const filesystem = makeFilesystem();
    await expect(
      runAgentRequest(
        sessionContext(undefined),
        { calls: [call("c1", "list_directory", { path: "/" })] },
        makeOptions(makeRegistry(), filesystem),
      ),
    ).rejects.toThrow(AppError);

    try {
      await runAgentRequest(
        sessionContext(undefined),
        { calls: [call("c1", "list_directory", { path: "/" })] },
        makeOptions(makeRegistry(), filesystem),
      );
      expect.unreachable("unauthenticated agent request must throw");
    } catch (error) {
      const err = error as AppError;
      expect(err.status).toBe(401);
      expect(err.code).toBe("auth/unauthorized");
    }
    expect(filesystem.calls).toEqual([]);
  });

  it("builds the dispatched actor from the SESSION, not the intent input", async () => {
    const seen: ToolExecutionContext[] = [];
    const capturingPolicy: ToolPolicy = (definition, context) => {
      seen.push(context);
      return defaultToolPolicy()(definition, context);
    };

    const result = await runAgentRequest(
      sessionContext(ACTIVE_USER),
      {
        calls: [
          call("c1", "list_directory", {
            path: "/home",
            userId: "attacker-id",
            email: "mallory@example.com",
            displayName: "Mallory",
            status: "active",
          }),
        ],
      },
      makeOptions(makeRegistry(), makeFilesystem(), capturingPolicy),
    );

    const outcome = result.results[0];
    expect(outcome).toBeDefined();
    if (!outcome) return;
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const context = seen[0];
    expect(context).toBeDefined();
    if (!context) return;
    const actor = context.actor;
    expect(actor.kind).toBe("ai-agent");
    if (actor.kind !== "ai-agent") return;
    expect(actor.identity.userId).toBe(ACTIVE_USER.id);
    expect(actor.identity.userId).not.toBe("attacker-id");
  });

  it("a failed intent returns a structured per-call error and does not stop the rest", async () => {
    const filesystem = makeFilesystem();
    const result = await runAgentRequest(
      sessionContext(ACTIVE_USER),
      {
        calls: [
          call("unknown", "not_a_tool", {}),
          call("valid", "list_directory", { path: "/home" }),
        ],
      },
      makeOptions(makeRegistry(), filesystem),
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      ok: false,
      callId: "unknown",
      error: expect.objectContaining({ category: "unknown_tool" }),
    });
    const validOutcome = result.results[1];
    expect(validOutcome).toBeDefined();
    if (!validOutcome) return;
    expect(validOutcome.ok).toBe(true);
    // The valid intent still ran after the failing one.
    expect(filesystem.calls).toEqual(["listDirectory:/home"]);
  });

  it("preserves the policy gate: a non-read permission intent is denied", async () => {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    registry.register(writeTool("create_file"));
    const filesystem = makeFilesystem();

    const result = await runAgentRequest(
      sessionContext(ACTIVE_USER),
      { calls: [call("w", "create_file", { path: "/home/new.txt" })] },
      makeOptions(registry, filesystem),
    );

    const writeOutcome = result.results[0];
    expect(writeOutcome).toBeDefined();
    if (!writeOutcome) return;
    expect(writeOutcome.ok).toBe(false);
    if (writeOutcome.ok) return;
    expect(writeOutcome.error.category).toBe("security");
    expect(writeOutcome.error.code).toBe(ToolErrorCode.PermissionDenied);
    expect(filesystem.calls).toEqual([]);
  });

  it("denies intents for a disabled session user (policy still applied)", async () => {
    const filesystem = makeFilesystem();
    const result = await runAgentRequest(
      sessionContext(PENDING_USER),
      { calls: [call("c1", "list_directory", { path: "/home" })] },
      makeOptions(makeRegistry(), filesystem),
    );
    const pendingOutcome = result.results[0];
    expect(pendingOutcome).toBeDefined();
    if (!pendingOutcome) return;
    expect(pendingOutcome.ok).toBe(false);
    if (pendingOutcome.ok) return;
    expect(pendingOutcome.error.category).toBe("security");
    expect(pendingOutcome.error.code).toBe(ToolErrorCode.IdentityInvalid);
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool (synthetic test fixture only).`,
    inputSchema: { type: "object" },
    permission: ToolPermission.Write,
  };
}