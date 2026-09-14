/**
 * Structured agent context tests (Phase 10.5).
 *
 * These tests prove the provider-independent context model:
 *
 *   1. Constructs the full context (instruction + available tools + prior
 *      results) and the separate authorized-user identity.
 *   2. Filters candidate tools down to those actually REGISTERED in the
 *      Tool Registry — unregistered candidates are dropped.
 *   3. Produces an empty/minimal context when there are no prior results.
 *   4. Propagates prior tool results through the context.
 *   5. Pre-flights authentication (fails closed, never grants anything)
 *      and never exposes identity/policy-bearing data to the provider.
 */
import { describe, expect, it } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { readToolDefinitions, registerReadTools } from "../tools/definitions/readTools.js";
import { ToolError, ToolErrorCode } from "../tools/errors.js";
import {
  ToolPermission,
  type ToolDefinition,
} from "../tools/types.js";
import {
  buildAgentContext,
  type AgentAuthContext,
  type AgentContext,
} from "./agentContext.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

/** An otherwise-complete read tool metadata candidate, unregistered by default. */
const phantomTool: ToolDefinition = {
  name: "phantom_list",
  description: "A synthetic tool that is NOT registered.",
  inputSchema: { type: "object" },
  permission: ToolPermission.Read,
};

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  return registry;
}

// ---------------------------------------------------------------------------
// 1. Context construction
// ---------------------------------------------------------------------------

describe("buildAgentContext — construction", () => {
  it("builds the provider context with instruction and available tools", () => {
    const { context, auth } = buildAgentContext({
      instruction: "list my home directory",
      tools: readToolDefinitions,
      registry: makeRegistry(),
      user: ACTIVE_USER,
    });

    expect(context.instruction).toBe("list my home directory");
    expect(context.tools).toEqual(readToolDefinitions);
    expect(context.toolResults).toBeUndefined();

    expect(auth.user.id).toBe(ACTIVE_USER.id);
    expect(auth.user.email).toBe(ACTIVE_USER.email);
    expect(auth.user.displayName).toBe(ACTIVE_USER.displayName);
  });

  it("returns distinct, typed context and auth channels", () => {
    const built = buildAgentContext({
      instruction: "hi",
      tools: [readToolDefinitions[0]!],
      registry: makeRegistry(),
      user: ACTIVE_USER,
    });
    const context: AgentContext = built.context;
    const auth: AgentAuthContext = built.auth;

    expect(context).toBeDefined();
    expect(auth).toBeDefined();
    expect(typeof context.instruction).toBe("string");
    expect(context.tools).toHaveLength(1);
    expect(auth.user).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Tool filtering (registry-gated availability)
// ---------------------------------------------------------------------------

describe("buildAgentContext — tool filtering", () => {
  it("drops candidates that are not registered in the Tool Registry", () => {
    const registry = makeRegistry();
    const { context } = buildAgentContext({
      instruction: "list things",
      tools: [phantomTool, readToolDefinitions[0]!],
      registry,
      user: ACTIVE_USER,
    });

    expect(context.tools).toEqual([readToolDefinitions[0]]);
  });

  it("keeps every available (registered) tool when all candidates are valid", () => {
    const registry = makeRegistry();
    const { context } = buildAgentContext({
      instruction: "help me",
      tools: readToolDefinitions,
      registry,
      user: ACTIVE_USER,
    });

    expect(context.tools.map((t) => t.name)).toEqual([
      "list_directory",
      "search_files",
      "get_file_metadata",
      "read_file",
    ]);
  });

  it("never exposes a tool that the provider could not actually invoke", () => {
    const registry = makeRegistry();
    const { context } = buildAgentContext({
      instruction: "read the file",
      tools: [phantomTool],
      registry,
      user: ACTIVE_USER,
    });

    expect(context.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Empty / minimal context
// ---------------------------------------------------------------------------

describe("buildAgentContext — empty context", () => {
  it("yields an empty tool set and no prior results for a bare candidate list", () => {
    const { context } = buildAgentContext({
      instruction: "nothing to do",
      tools: [],
      registry: makeRegistry(),
      user: ACTIVE_USER,
    });

    expect(context.tools).toEqual([]);
    expect(context.toolResults).toBeUndefined();
  });

  it("omits the toolResults field when there are no prior results", () => {
    const { context } = buildAgentContext({
      instruction: "hi",
      tools: readToolDefinitions,
      registry: makeRegistry(),
      user: ACTIVE_USER,
    });
    expect(context.toolResults).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Tool-result propagation
// ---------------------------------------------------------------------------

describe("buildAgentContext — tool-result propagation", () => {
  const priorResults = [
    { ok: true as const, callId: "a", data: { path: "/home" } },
    {
      ok: false as const,
      callId: "b",
      error: new ToolError("validation", ToolErrorCode.InvalidInput, "bad input"),
    },
  ];

  it("propagates prior tool results into the provider context", () => {
    const { context } = buildAgentContext({
      instruction: "continue",
      tools: readToolDefinitions,
      registry: makeRegistry(),
      user: ACTIVE_USER,
      toolResults: priorResults,
    });

    expect(context.toolResults).toEqual(priorResults);
  });

  it("propagates an empty prior-result array as no toolResults field", () => {
    const { context } = buildAgentContext({
      instruction: "continue",
      tools: readToolDefinitions,
      registry: makeRegistry(),
      user: ACTIVE_USER,
      toolResults: [],
    });

    expect(context.toolResults).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Authentication, separation, and non-granting
// ---------------------------------------------------------------------------

describe("buildAgentContext — auth, separation, and non-granting", () => {
  it("fails closed (throws unauthorized) when there is no valid session", () => {
    expect(() =>
      buildAgentContext({
        instruction: "hi",
        tools: readToolDefinitions,
        registry: makeRegistry(),
        user: undefined,
      }),
    ).toThrow(AppError);
  });

  it("never puts identity or the registry handle into the provider context", () => {
    const { context } = buildAgentContext({
      instruction: "hi",
      tools: readToolDefinitions,
      registry: makeRegistry(),
      user: ACTIVE_USER,
    });

    expect("user" in context).toBe(false);
    expect("identity" in context).toBe(false);
    expect("registry" in context).toBe(false);
  });

  it("rejects a non-string instruction before exposing any context", () => {
    expect(() =>
      buildAgentContext({
        instruction: 42 as unknown as string,
        tools: readToolDefinitions,
        registry: makeRegistry(),
        user: ACTIVE_USER,
      }),
    ).toThrow(TypeError);
  });
});
