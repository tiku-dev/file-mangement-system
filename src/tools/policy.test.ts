/**
 * Policy layer tests (Phase 9.5).
 *
 * These tests prove the policy layer in isolation from the rest of
 * the tool stack. They use synthetic `ToolDefinition` objects so the
 * tests do not depend on the read-only tool definitions or on the
 * FilesystemExecutor. The dispatch integration is tested in the
 * `handlers.test.ts` file.
 *
 * Coverage:
 *
 *   - defaultToolPolicy: each rule (context, actor, permission)
 *   - enforcePolicy: pass-through, default-policy invocation, custom policy
 *   - dispatch integration: policy runs before the handler, denied tools
 *     never reach the executor
 */
import { describe, expect, it, vi } from "vitest";

import {
  ToolPermission,
  type ToolDefinition,
} from "./types.js";
import { ToolError, ToolErrorCode, isToolError } from "./errors.js";
import {
  authenticatedAiAgent,
  defaultToolPolicy,
  enforcePolicy,
  type ToolActor,
  type ToolActorIdentity,
  type ToolExecutionContext,
  type ToolPolicy,
} from "./policy.js";

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

function writeTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    permission: ToolPermission.Write,
  };
}

function destructiveTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    permission: ToolPermission.Destructive,
  };
}

/**
 * A canonical "active" authenticated user, used by the default
 * `aiContext()` fixture. Matches the shape the auth layer's
 * `AuthUser` produces so tests exercise the same path a future
 * HTTP route would.
 */
const ACTIVE_USER = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "test@example.com",
  displayName: "Test User",
  status: "active",
};

/**
 * Default ai-agent actor for the tests. Built through the canonical
 * builder so the tests exercise the same code path a future caller
 * would.
 */
const AI_AGENT: ToolActor = authenticatedAiAgent(ACTIVE_USER);
const USER: ToolActor = { kind: "user" };

function aiContext(): ToolExecutionContext {
  return { actor: AI_AGENT };
}

// ---------------------------------------------------------------------------
// defaultToolPolicy
// ---------------------------------------------------------------------------

describe("defaultToolPolicy — happy path", () => {
  it("allows a read-only tool with an AI-agent context", () => {
    const decision = defaultToolPolicy()(readTool("list_directory"), aiContext());
    expect(decision.allowed).toBe(true);
  });

  it("allows all four Phase 9.2 read tools", () => {
    const policy = defaultToolPolicy();
    const ctx = aiContext();
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

describe("defaultToolPolicy — denied: non-Read permission", () => {
  it("denies a write tool with category=security", () => {
    const decision = defaultToolPolicy()(writeTool("create_file"), aiContext());
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.category).toBe("security");
    expect(decision.reason.code).toBe(ToolErrorCode.PermissionDenied);
    expect(decision.reason.status).toBe(403);
    // The message names the tool so callers know which one was denied.
    expect(decision.reason.message).toContain("create_file");
    expect(decision.reason.message).toContain("write");
  });

  it("denies a destructive tool with category=security", () => {
    const decision = defaultToolPolicy()(
      destructiveTool("delete_file"),
      aiContext(),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.category).toBe("security");
    expect(decision.reason.code).toBe(ToolErrorCode.PermissionDenied);
    expect(decision.reason.message).toContain("delete_file");
    expect(decision.reason.message).toContain("destructive");
  });
});

describe("defaultToolPolicy — denied: actor kind", () => {
  it("denies a user actor with category=security", () => {
    const decision = defaultToolPolicy()(readTool("list_directory"), {
      actor: USER,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.category).toBe("security");
    expect(decision.reason.code).toBe(ToolErrorCode.PermissionDenied);
    expect(decision.reason.message).toContain("user");
  });
});

describe("defaultToolPolicy — denied: missing or invalid context", () => {
  it("denies a null context", () => {
    const policy = defaultToolPolicy();
    const decision = policy(readTool("list_directory"), null as unknown as ToolExecutionContext);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.category).toBe("security");
    expect(decision.reason.code).toBe(ToolErrorCode.PolicyContextMissing);
  });

  it("denies an undefined context", () => {
    const policy = defaultToolPolicy();
    const decision = policy(
      readTool("list_directory"),
      undefined as unknown as ToolExecutionContext,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.code).toBe(ToolErrorCode.PolicyContextMissing);
  });

  it("denies a context with a missing actor", () => {
    const policy = defaultToolPolicy();
    const decision = policy(
      readTool("list_directory"),
      {} as unknown as ToolExecutionContext,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.code).toBe(ToolErrorCode.PolicyContextMissing);
  });

  it("denies a context with an actor missing a `kind`", () => {
    const policy = defaultToolPolicy();
    const decision = policy(readTool("list_directory"), {
      actor: {},
    } as unknown as ToolExecutionContext);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason.code).toBe(ToolErrorCode.PolicyContextMissing);
  });
});


// ---------------------------------------------------------------------------
// enforcePolicy
// ---------------------------------------------------------------------------

describe("enforcePolicy", () => {
  it("returns null when the default policy allows the call", () => {
    const err = enforcePolicy(readTool("list_directory"), aiContext());
    expect(err).toBeNull();
  });

  it("returns a ToolError when the default policy denies the call", () => {
    const err = enforcePolicy(writeTool("create_file"), aiContext());
    expect(err).not.toBeNull();
    if (err === null) return;
    expect(err.category).toBe("security");
    expect(err.code).toBe(ToolErrorCode.PermissionDenied);
  });

  it("returns a ToolError when the context is null", () => {
    const err = enforcePolicy(readTool("list_directory"), null);
    expect(err).not.toBeNull();
    if (err === null) return;
    expect(err.category).toBe("security");
    expect(err.code).toBe(ToolErrorCode.PolicyContextMissing);
  });

  it("returns a ToolError when the context is undefined", () => {
    const err = enforcePolicy(readTool("list_directory"), undefined);
    expect(err).not.toBeNull();
    if (err === null) return;
    expect(err.code).toBe(ToolErrorCode.PolicyContextMissing);
  });

  it("uses the supplied custom policy when one is provided", () => {
    const denyAll: ToolPolicy = () => ({
      allowed: false,
      reason: ToolError.security("tools/permission-denied", "denied by test"),
    });
    const err = enforcePolicy(readTool("list_directory"), aiContext(), denyAll);
    expect(err).not.toBeNull();
    if (err === null) return;
    expect(err.code).toBe("tools/permission-denied");
  });

  it("lets a custom policy allow a tool the default policy would deny", () => {
    const allowAll: ToolPolicy = () => ({ allowed: true });
    const err = enforcePolicy(writeTool("create_file"), aiContext(), allowAll);
    expect(err).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Structured error shape
// ---------------------------------------------------------------------------

describe("policy errors are structured ToolErrors", () => {
  it("permission-denied errors carry category=security and status=403", () => {
    const err = enforcePolicy(writeTool("x"), aiContext());
    expect(isToolError(err)).toBe(true);
    if (err === null) return;
    expect(err.category).toBe("security");
    expect(err.status).toBe(403);
    expect(err.name).toBe("ToolError");
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("missing-context errors carry category=security and status=403", () => {
    const err = enforcePolicy(readTool("x"), null);
    expect(isToolError(err)).toBe(true);
    if (err === null) return;
    expect(err.category).toBe("security");
    expect(err.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("policy is pure", () => {
  it("defaultToolPolicy returns the same decision for the same inputs", () => {
    const policy = defaultToolPolicy();
    const def = readTool("x");
    const ctx = aiContext();
    const a = policy(def, ctx);
    const b = policy(def, ctx);
    expect(a).toEqual(b);
  });

  it("the factory returns a fresh function each call, but each makes the same decision", () => {
    const a = defaultToolPolicy();
    const b = defaultToolPolicy();
    expect(a).not.toBe(b);
    const def = readTool("x");
    const ctx = aiContext();
    expect(a(def, ctx)).toEqual(b(def, ctx));
  });
});



// ---------------------------------------------------------------------------
// Dispatch integration: policy runs before the handler; denied tools
// never reach the handler. These tests use a minimal in-test dispatch
// loop (rather than the production `dispatchTool`) so we can register
// a write tool and prove the policy gate stops it.
// ---------------------------------------------------------------------------

async function buildTestDispatch(args: {
  writeTool: ToolDefinition;
  readTool: ToolDefinition;
  handlerFn: () => unknown;
}) {
  const { ToolRegistry, isToolRegistryError } = await import("./registry.js");
  const { ToolError, ToolErrorCode } = await import("./errors.js");
  const { enforcePolicy } = await import("./policy.js");

  const registry = new ToolRegistry();
  registry.register(args.readTool);
  registry.register(args.writeTool);
  const handlers = {
    [args.readTool.name]: args.handlerFn,
    [args.writeTool.name]: args.handlerFn,
  };

  return async function dispatch(
    toolName: string,
    ctx: ToolExecutionContext | null,
  ) {
    let definition;
    try {
      definition = registry.get(toolName);
    } catch (error) {
      if (isToolRegistryError(error)) {
        return {
          ok: false as const,
          error: new ToolError(
            "unknown_tool",
            error.code,
            `The requested tool "${toolName}" is not available.`,
          ),
        };
      }
      return { ok: false as const, error: ToolError.internal() };
    }
    const policyError = enforcePolicy(definition, ctx);
    if (policyError !== null) {
      return { ok: false as const, error: policyError };
    }
    const handler = (handlers as Record<string, (() => unknown) | undefined>)[
      toolName
    ];
    if (!handler) {
      return {
        ok: false as const,
        error: new ToolError(
          "internal",
          ToolErrorCode.HandlerMissing,
          `The requested tool "${toolName}" has no registered handler.`,
        ),
      };
    }
    const data = handler();
    return { ok: true as const, data };
  };
}

describe("dispatch integration — policy runs before the handler", () => {
  it("a denied call returns category=security and the handler is never invoked", async () => {
    const handlerFn = vi.fn();
    const dispatch = await buildTestDispatch({
      writeTool: writeTool("create_file"),
      readTool: readTool("list_directory"),
      handlerFn,
    });
    const result = await dispatch("create_file", aiContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.PermissionDenied);
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("an allowed call reaches the handler and returns its data", async () => {
    const handlerFn = vi.fn(() => "ok");
    const dispatch = await buildTestDispatch({
      writeTool: writeTool("create_file"),
      readTool: readTool("list_directory"),
      handlerFn,
    });
    const result = await dispatch("list_directory", aiContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe("ok");
    expect(handlerFn).toHaveBeenCalledTimes(1);
  });

  it("missing context returns a security error before any handler is invoked", async () => {
    const handlerFn = vi.fn();
    const dispatch = await buildTestDispatch({
      writeTool: writeTool("create_file"),
      readTool: readTool("list_directory"),
      handlerFn,
    });
    const result = await dispatch("list_directory", null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.PolicyContextMissing);
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("a user actor is denied even on a read tool", async () => {
    const handlerFn = vi.fn();
    const dispatch = await buildTestDispatch({
      writeTool: writeTool("create_file"),
      readTool: readTool("list_directory"),
      handlerFn,
    });
    const result = await dispatch("list_directory", { actor: USER });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(handlerFn).not.toHaveBeenCalled();
  });
});
