/**
 * Session → Tool Execution Context integration tests (Phase 9.7).
 *
 * These tests prove the complete flow end to end:
 *
 *   Authenticated request
 *   → requireAuth middleware (Phase 7, real — session repository mocked)
 *   → AuthUser on Hono context
 *   → createSessionExecutionContext(c)
 *   → ToolExecutionContext
 *   → dispatchTool() → policy → handler
 *
 * Coverage:
 *
 *   1. Authenticated user → valid execution context.
 *   2. Unauthenticated request → rejected (401).
 *   3. Inactive / invalid user → rejected (401 at the session layer,
 *      and denied by the policy layer for defense in depth).
 *   4. Request-supplied identity cannot override session identity.
 *   5. The resulting context works with dispatchTool() — the real
 *      dispatcher runs the handler.
 *
 * The session repository and DB clock are mocked so the tests run on
 * the production `requireAuth` + dispatcher without a database or a
 * Tauri/Rust executor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { AppError } from "../core/errors.js";
import { onError } from "../core/http.js";
import * as auth from "../core/auth.js";
import { ToolRegistry } from "./registry.js";
import { ToolPermission, type ToolDefinition } from "./types.js";
import {
  createToolExecutionContext,
  defaultToolPolicy,
  type ToolActorIdentity,
} from "./policy.js";
import { createSessionExecutionContext } from "./sessionContext.js";
import { dispatchTool } from "./handlers/index.js";
import type { FilesystemExecutor } from "./executor.js";

// ---------------------------------------------------------------------------
// Session repository / DB clock mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  findSessionByTokenHash: vi.fn(),
  updateSessionLastUsedAt: vi.fn(),
  databaseNow: vi.fn(),
}));

vi.mock("../database/repositories/sessions.js", () => ({
  createSession: vi.fn(),
  findSessionByTokenHash: mocks.findSessionByTokenHash,
  updateSessionLastUsedAt: mocks.updateSessionLastUsedAt,
  deleteSessionByTokenHash: vi.fn(),
}));

vi.mock("../database/client.js", () => ({
  databaseNow: mocks.databaseNow,
}));

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

function sessionFor(user: { id: string; email: string; displayName: string; status: string }): unknown {
  return {
    id: "session-1",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    user,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateSessionLastUsedAt.mockResolvedValue(undefined);
  mocks.databaseNow.mockResolvedValue(new Date("2026-01-01T00:00:00Z"));
});

/**
 * A minimal Hono app wired exactly like a real tool route would be:
 * `onError` envelope + `requireAuth` middleware + a handler that
 * builds the execution context from the session.
 */
function makeApp(): Hono {
  const app = new Hono();
  app.onError(onError);
  app.post(
    "/execute",
    auth.requireAuth,
    (c) => {
      const context = createSessionExecutionContext(c);
      return c.json({ ok: true, context });
    },
  );
  return app;
}

// ---------------------------------------------------------------------------
// 1. Authenticated user → valid execution context
// ---------------------------------------------------------------------------

describe("createSessionExecutionContext — authenticated session", () => {
  it("builds a valid execution context from the authenticated session user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const res = await makeApp().request("/execute", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      context: { actor: { kind: string; identity: ToolActorIdentity } };
    };
    expect(body.ok).toBe(true);

    // The identity must be established by the session, matching the
    // shape of `AuthenticatedUserLike` exactly.
    expect(body.context.actor.kind).toBe("ai-agent");
    const identity = body.context.actor.identity;
    expect(identity.userId).toBe(ACTIVE_USER.id);
    expect(identity.email).toBe(ACTIVE_USER.email);
    expect(identity.displayName).toBe(ACTIVE_USER.displayName);
    expect(identity.status).toBe("active");
  });

  it("builds the canonical ai-agent actor kind by default", () => {
    const context = createSessionExecutionContext({ get: () => ACTIVE_USER });
    expect(context.actor.kind).toBe("ai-agent");
  });
});

// ---------------------------------------------------------------------------
// 2. Unauthenticated request → rejected
// ---------------------------------------------------------------------------

describe("createSessionExecutionContext — unauthenticated request", () => {
  it("throws AppError.unauthorized for a request with no session", () => {
    const c = { get: () => undefined };
    expect(() => createSessionExecutionContext(c)).toThrow(AppError);
    try {
      createSessionExecutionContext(c);
    } catch (error) {
      const err = error as AppError;
      expect(err.status).toBe(401);
      expect(err.code).toBe("auth/unauthorized");
      return;
    }
  });

  it("rejects an HTTP request with no token before it reaches the handler", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const res = await makeApp().request("/execute", {
      method: "POST",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth/unauthorized");
  });
});

// ---------------------------------------------------------------------------
// 3. Inactive / invalid user → rejected
// ---------------------------------------------------------------------------

describe("createSessionExecutionContext — inactive / invalid user", () => {
  it("rejects an HTTP request whose session user is not active", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(PENDING_USER));
    const res = await makeApp().request("/execute", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth/unauthorized");
  });

  it("a context built for an inactive user is denied by the policy layer", () => {
    // Defense in depth: even if an inactive identity reached dispatch
    // (requireAuth normally prevents it), the policy denies the tool.
    const policy = defaultToolPolicy();
    const context = createToolExecutionContext({
      id: PENDING_USER.id,
      email: PENDING_USER.email,
      displayName: PENDING_USER.displayName,
      status: "pending",
    });
    const decision = policy(readTool("list_directory"), context);
    expect(decision.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Request-supplied identity cannot override session identity
// ---------------------------------------------------------------------------

describe("createSessionExecutionContext — request cannot override identity", () => {
  it("ignores a conflicting identity in the request body and uses the session user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const res = await makeApp().request("/execute", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        identity: {
          userId: "attacker-id",
          email: "mallory@example.com",
          displayName: "Mallory",
          status: "active",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      context: { actor: { identity: ToolActorIdentity } };
    };
    // The context is built ONLY from the session established by
    // requireAuth — the request-supplied identity is never consulted.
    expect(body.context.actor.identity.userId).toBe(ACTIVE_USER.id);
    expect(body.context.actor.identity.email).toBe(ACTIVE_USER.email);
    expect(body.context.actor.identity.userId).not.toBe("attacker-id");
  });
});

// ---------------------------------------------------------------------------
// 5. Resulting context works with dispatchTool()
// ---------------------------------------------------------------------------

describe("createSessionExecutionContext — dispatch integration", () => {
  function makeFilesystem(): FilesystemExecutor {
    return {
      async listDirectory() {
        return { path: "/", parentPath: null, isHome: false, items: [] };
      },
      async searchFiles() {
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

  it("a context from the session dispatches a read tool to its handler", async () => {
    const context = createSessionExecutionContext({ get: () => ACTIVE_USER });
    const registry = new ToolRegistry();
    registry.register(readTool("list_directory"));
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      { filesystem: makeFilesystem() },
      context,
    );
    expect(result.ok).toBe(true);
  });

  it("the same context is rejected with a security error when the user is not active", async () => {
    const context = createToolExecutionContext({
      id: PENDING_USER.id,
      email: PENDING_USER.email,
      displayName: PENDING_USER.displayName,
      status: "pending",
    });
    const registry = new ToolRegistry();
    registry.register(readTool("list_directory"));
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      { filesystem: makeFilesystem() },
      context,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object" },
    permission: ToolPermission.Read,
  };
}