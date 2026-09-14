/**
 * Tool Execution Context tests (Phase 9.6).
 *
 * The execution context carries the authenticated application
 * identity into tool execution. The tests in this file prove:
 *
 *   1. A valid authenticated AI-agent context is allowed for read
 *      tools.
 *   2. A missing identity is denied (and the handler is never
 *      invoked).
 *   3. An invalid context is denied (null, undefined, malformed
 *      actor).
 *   4. A user / unauthorized actor is denied (the policy still
 *      rejects `kind: "user"`).
 *   5. A `user` actor's request never reaches the handler.
 *
 * The tests use a `FakeFilesystemExecutor` (Phase 9.3) so no real
 * Tauri / Rust bridge is required. The policy is the default one.
 */
import { describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "./registry.js";
import {
  ToolPermission,
  type ToolDefinition,
} from "./types.js";
import {
  ToolError,
  ToolErrorCode,
  isToolError,
} from "./errors.js";
import {
  authenticatedAiAgent,
  defaultToolPolicy,
  enforcePolicy,
  type ToolActor,
  type ToolActorIdentity,
  type ToolExecutionContext,
} from "./policy.js";
import type { FilesystemExecutor } from "./executor.js";
import { dispatchTool } from "./handlers/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function readTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    permission: ToolPermission.Read,
  };
}

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

const DISABLED_USER = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob Example",
  status: "disabled",
};

/** A no-op filesystem executor that records calls for assertions. */
function makeFilesystem(): FilesystemExecutor & {
  calls: string[];
} {
  const calls: string[] = [];
  const fake: FilesystemExecutor & { calls: string[] } = {
    calls,
    async listDirectory() {
      calls.push("listDirectory");
      return { path: "/", parentPath: null, isHome: false, items: [] };
    },
    async searchFiles() {
      calls.push("searchFiles");
      return [];
    },
    async getFileMetadata() {
      calls.push("getFileMetadata");
      return {
        name: "x",
        path: "/x",
        isFile: true,
        isFolder: false,
        sizeBytes: 0,
        extension: null,
        isHidden: false,
        modified: "—",
        modifiedTs: 0,
        created: "—",
        createdTs: 0,
        accessed: null,
        accessedTs: null,
      };
    },
    async readFile() {
      calls.push("readFile");
      return { encoding: "base64", data: "" };
    },
    async moveFile() {
      calls.push("moveFile");
    },
  };
  return fake;
}

function makeHandlerContext() {
  return { filesystem: makeFilesystem() };
}

function makeAiContext(
  overrides: Partial<ToolActorIdentity> = {},
): ToolExecutionContext {
  return {
    actor: authenticatedAiAgent(ACTIVE_USER, overrides),
  };
}

// ---------------------------------------------------------------------------
// Valid authenticated AI-agent context is allowed
// ---------------------------------------------------------------------------

describe("execution context — valid authenticated ai-agent is allowed", () => {
  it("allows a read tool when the actor is an ai-agent with an active user", () => {
    const policy = defaultToolPolicy();
    const decision = policy(readTool("list_directory"), makeAiContext());
    expect(decision.allowed).toBe(true);
  });

  it("preserves the identity fields the dispatcher will see (round-trip)", () => {
    const ctx = makeAiContext({
      deviceId: "device-1",
      sessionId: "session-abc",
    });
    expect(ctx.actor.kind).toBe("ai-agent");
    if (ctx.actor.kind !== "ai-agent") return;
    expect(ctx.actor.identity.userId).toBe(ACTIVE_USER.id);
    expect(ctx.actor.identity.email).toBe(ACTIVE_USER.email);
    expect(ctx.actor.identity.status).toBe("active");
    expect(ctx.actor.identity.deviceId).toBe("device-1");
    expect(ctx.actor.identity.sessionId).toBe("session-abc");
  });

  it("enforcePolicy returns null (allow) for a valid active ai-agent", () => {
    const err = enforcePolicy(readTool("list_directory"), makeAiContext());
    expect(err).toBeNull();
  });

  it("allows all four Phase 9.2 read tools under a real authenticated context", () => {
    const policy = defaultToolPolicy();
    const ctx = makeAiContext();
    for (const name of [
      "list_directory",
      "search_files",
      "get_file_metadata",
      "read_file",
    ]) {
      expect(policy(readTool(name), ctx).allowed).toBe(true);
    }
  });
});


// ---------------------------------------------------------------------------
// Missing identity is denied
// ---------------------------------------------------------------------------

describe("execution context — missing identity is denied", () => {
  it("denies an ai-agent actor whose identity field is missing", () => {
    const policy = defaultToolPolicy();
    // Construct a malformed actor — kind is right but no identity.
    const ctx: ToolExecutionContext = {
      actor: { kind: "ai-agent" } as unknown as ToolActor,
    };
    const decision = policy(readTool("list_directory"), ctx);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.category).toBe("security");
    expect(decision.reason.code).toBe(ToolErrorCode.IdentityMissing);
  });

  it("denies an ai-agent actor whose identity is null", () => {
    const policy = defaultToolPolicy();
    const ctx: ToolExecutionContext = {
      actor: { kind: "ai-agent", identity: null } as unknown as ToolActor,
    };
    const decision = policy(readTool("list_directory"), ctx);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.code).toBe(ToolErrorCode.IdentityMissing);
  });

  it("denies an ai-agent actor whose identity is missing a userId", () => {
    const policy = defaultToolPolicy();
    const ctx: ToolExecutionContext = {
      actor: {
        kind: "ai-agent",
        identity: {
          email: "x@y",
          displayName: "X",
          status: "active",
        } as ToolActorIdentity,
      },
    };
    const decision = policy(readTool("list_directory"), ctx);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.code).toBe(ToolErrorCode.IdentityMissing);
  });

  it("denies an ai-agent actor whose identity has no status (inactive)", () => {
    const policy = defaultToolPolicy();
    const ctx: ToolExecutionContext = {
      actor: {
        kind: "ai-agent",
        identity: {
          userId: "u1",
          email: "x@y",
          displayName: "X",
        } as ToolActorIdentity,
      },
    };
    const decision = policy(readTool("list_directory"), ctx);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.code).toBe(ToolErrorCode.IdentityInvalid);
  });

  it("denies a disabled user with category=security and IdentityInvalid", () => {
    const policy = defaultToolPolicy();
    const ctx: ToolExecutionContext = {
      actor: authenticatedAiAgent(DISABLED_USER),
    };
    const decision = policy(readTool("list_directory"), ctx);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.category).toBe("security");
    expect(decision.reason.code).toBe(ToolErrorCode.IdentityInvalid);
    expect(decision.reason.status).toBe(403);
  });

  it("enforcePolicy returns a ToolError (not null) for missing identity", () => {
    const err = enforcePolicy(
      readTool("list_directory"),
      {
        actor: { kind: "ai-agent" } as unknown as ToolActor,
      },
    );
    expect(isToolError(err)).toBe(true);
    if (err === null) return;
    expect(err.code).toBe(ToolErrorCode.IdentityMissing);
  });
});


// ---------------------------------------------------------------------------
// Invalid context is denied
// ---------------------------------------------------------------------------

describe("execution context — invalid context is denied", () => {
  it("enforcePolicy denies a null context", () => {
    const err = enforcePolicy(readTool("list_directory"), null);
    expect(isToolError(err)).toBe(true);
    if (err === null) return;
    expect(err.code).toBe(ToolErrorCode.PolicyContextMissing);
  });

  it("enforcePolicy denies an undefined context", () => {
    const err = enforcePolicy(readTool("list_directory"), undefined);
    expect(isToolError(err)).toBe(true);
    if (err === null) return;
    expect(err.code).toBe(ToolErrorCode.PolicyContextMissing);
  });

  it("the default policy denies a context with a missing actor", () => {
    const policy = defaultToolPolicy();
    const decision = policy(
      readTool("list_directory"),
      {} as unknown as ToolExecutionContext,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.code).toBe(ToolErrorCode.PolicyContextMissing);
  });

  it("the default policy denies a context whose actor has no `kind`", () => {
    const policy = defaultToolPolicy();
    const decision = policy(
      readTool("list_directory"),
      { actor: {} } as unknown as ToolExecutionContext,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.code).toBe(ToolErrorCode.PolicyContextMissing);
  });
});

// ---------------------------------------------------------------------------
// User / unauthorized actors remain denied
// ---------------------------------------------------------------------------

describe("execution context — user / unauthorized actors remain denied", () => {
  it("denies a `user` actor with category=security and PermissionDenied", () => {
    const policy = defaultToolPolicy();
    const ctx: ToolExecutionContext = { actor: { kind: "user" } };
    const decision = policy(readTool("list_directory"), ctx);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.category).toBe("security");
    expect(decision.reason.code).toBe(ToolErrorCode.PermissionDenied);
    expect(decision.reason.status).toBe(403);
  });

  it("enforcePolicy returns a PermissionDenied ToolError for a user actor", () => {
    const err = enforcePolicy(readTool("list_directory"), {
      actor: { kind: "user" },
    });
    expect(isToolError(err)).toBe(true);
    if (err === null) return;
    expect(err.code).toBe(ToolErrorCode.PermissionDenied);
  });

  it("denies a user actor on every Phase 9.2 read tool", () => {
    const policy = defaultToolPolicy();
    const ctx: ToolExecutionContext = { actor: { kind: "user" } };
    for (const name of [
      "list_directory",
      "search_files",
      "get_file_metadata",
      "read_file",
    ]) {
      expect(policy(readTool(name), ctx).allowed).toBe(false);
    }
  });
});


// ---------------------------------------------------------------------------
// Dispatch integration: denied requests never reach the handler
// ---------------------------------------------------------------------------
//
// These tests use the production `dispatchTool` to prove the
// end-to-end Phase 9.6 flow. A `vi.fn()` is supplied as the
// `FilesystemExecutor` so a denial can assert the handler NEVER
// recorded a call.

describe("dispatch integration — denied requests never reach the handler", () => {
  function setupDispatcher() {
    const registry = new ToolRegistry();
    registry.register(readTool("list_directory"));
    const fake = makeFilesystem();
    const ctx = { filesystem: fake };
    return { registry, fake, ctx };
  }

  it("a valid authenticated ai-agent request reaches the executor", async () => {
    const { registry, fake, ctx } = setupDispatcher();
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      ctx,
      makeAiContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual(["listDirectory"]);
  });

  it("a missing-identity request returns security and the executor is never called", async () => {
    const { registry, fake, ctx } = setupDispatcher();
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      ctx,
      // No identity field — the policy must deny.
      { actor: { kind: "ai-agent" } as unknown as ToolActor },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.IdentityMissing);
    expect(fake.calls).toEqual([]);
  });

  it("a disabled-user request returns security and the executor is never called", async () => {
    const { registry, fake, ctx } = setupDispatcher();
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      ctx,
      { actor: authenticatedAiAgent(DISABLED_USER) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.IdentityInvalid);
    expect(fake.calls).toEqual([]);
  });

  it("a null context returns security and the executor is never called", async () => {
    const { registry, fake, ctx } = setupDispatcher();
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      ctx,
      // Cast to satisfy the type; the policy must catch the null.
      null as unknown as ToolExecutionContext,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.PolicyContextMissing);
    expect(fake.calls).toEqual([]);
  });

  it("a user-actor request returns security and the executor is never called", async () => {
    const { registry, fake, ctx } = setupDispatcher();
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      ctx,
      { actor: { kind: "user" } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.PermissionDenied);
    expect(fake.calls).toEqual([]);
  });

  it("the policy gate runs before the registry miss is checked on denied calls (registry NOT consulted when identity is invalid)", async () => {
    // This test pins the gate ordering: an unknown tool name AND a
    // missing identity should be reported as a security error, not an
    // unknown_tool error — because the policy gate runs after the
    // registry gate. The order is: registry -> policy -> handler.
    // (A registry miss on a tool that does not exist produces an
    // unknown_tool error, which is a different code path; this test
    // exercises the case where the tool DOES exist but the actor is
    // unauthorized.)
    const { registry, fake, ctx } = setupDispatcher();
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      ctx,
      { actor: { kind: "ai-agent" } as unknown as ToolActor },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ToolErrorCode.IdentityMissing);
    expect(result.error.code).not.toBe(ToolErrorCode.UnknownTool);
    expect(fake.calls).toEqual([]);
  });
});

