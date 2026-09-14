/**
 * Provider-independent AI boundary tests (Phase 10.2).
 *
 * These tests use a FAKE provider only — no real AI provider, no API
 * key, no network access. They prove:
 *
 *   1. The provider receives the provider-agnostic request/context.
 *   2. A text-only response requires no tool execution.
 *   3. Tool-call intents are routed through runAgentRequest() →
 *      invokeTool() — the provider is never allowed to execute tools.
 *   4. Text + tool calls are returned together.
 *   5. Provider failures surface as the typed `ProviderError` contract.
 *   6. Provider output is re-validated before routing (not trusted).
 *   7. The policy gate still applies to provider-produced intents.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerReadTools } from "../tools/definitions/readTools.js";
import {
  ToolPermission,
  type ToolDefinition,
} from "../tools/types.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import type { InvokeToolOptions } from "./tools.js";
import type {
  AgentProvider,
  AgentResponse,
  AgentTurn,
} from "./provider.js";
import type { AgentToolCall } from "./agent.js";
import {
  isProviderError,
  ProviderError,
  ProviderErrorCode,
  runAgentTurn,
} from "./provider.js";

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
): InvokeToolOptions {
  return { registry, filesystem };
}

/** A fake provider that returns a scripted response or throws a scripted error. */
function fakeProvider(response: AgentResponse | ProviderError): {
  provider: AgentProvider;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn<AgentProvider["generate"]>().mockImplementation(async () => {
    if (isProviderError(response)) throw response;
    return response;
  });
  return { provider: { generate }, generate };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

// ---------------------------------------------------------------------------
// 1. The provider receives the provider-agnostic request/context
// ---------------------------------------------------------------------------

describe("AgentProvider — request context", () => {
  it("receives the user message and the plain tool metadata", async () => {
    const { provider, generate } = fakeProvider({ text: "ok" });
    const turn: AgentTurn = {
      message: "List my home directory",
      tools: [{ name: "list_directory" } as unknown as ToolDefinition],
    };
    const result = await runAgentTurn(
      sessionContext(ACTIVE_USER),
      provider,
      turn,
      makeOptions(makeRegistry(), makeFilesystem()),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      message: "List my home directory",
      tools: turn.tools,
    });
    expect(result.text).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 2. Text-only response — no tool execution
// ---------------------------------------------------------------------------

describe("AgentProvider — text-only response", () => {
  it("returns the text and executes no tools", async () => {
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider({ text: "Here is your answer." });

    const result = await runAgentTurn(
      sessionContext(ACTIVE_USER),
      provider,
      { message: "Hello", tools: [] },
      makeOptions(makeRegistry(), filesystem),
    );

    expect(result.text).toBe("Here is your answer.");
    expect(result.results).toEqual([]);
    expect(filesystem.calls).toEqual([]);
  });

  it("returns an empty response (no text, no intents) as an empty turn", async () => {
    const { provider } = fakeProvider({});
    const result = await runAgentTurn(
      sessionContext(ACTIVE_USER),
      provider,
      { message: "Hello", tools: [] },
      makeOptions(makeRegistry(), makeFilesystem()),
    );
    expect(result.text).toBeUndefined();
    expect(result.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Tool-call intents are routed through the authenticated pipeline
// ---------------------------------------------------------------------------

describe("AgentProvider — tool-call routing", () => {
  it("routes provider intents through invokeTool() and returns correlated results", async () => {
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider({
      text: "Done.",
      toolCalls: [call("a", "list_directory", { path: "/home" })],
    });

    const result = await runAgentTurn(
      sessionContext(ACTIVE_USER),
      provider,
      { message: "Show /home", tools: [] },
      makeOptions(makeRegistry(), filesystem),
    );

    // The provider requested one intent; the AGENT layer executed it.
    expect(result.text).toBe("Done.");
    expect(result.results).toEqual([
      {
        ok: true,
        callId: "a",
        data: { path: "/home", parentPath: null, isHome: false, items: [] },
      },
    ]);
    expect(filesystem.calls).toEqual(["listDirectory:/home"]);
  });

  it("executes intents in provider order", async () => {
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider({
      toolCalls: [
        call("x", "search_files", { query: "first" }),
        call("y", "list_directory", { path: "/second" }),
      ],
    });
    await runAgentTurn(
      sessionContext(ACTIVE_USER),
      provider,
      { message: "both", tools: [] },
      makeOptions(makeRegistry(), filesystem),
    );
    expect(filesystem.calls).toEqual(["searchFiles", "listDirectory:/second"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Text + tool calls returned together
// ---------------------------------------------------------------------------

describe("AgentProvider — text and tool calls together", () => {
  it("returns both the text and the routed results", async () => {
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider({
      text: "I searched for you.",
      toolCalls: [call("t", "search_files", { query: "notes" })],
    });
    const result = await runAgentTurn(
      sessionContext(ACTIVE_USER),
      provider,
      { message: "find notes", tools: [] },
      makeOptions(makeRegistry(), filesystem),
    );
    expect(result.text).toBe("I searched for you.");
    expect(result.results).toHaveLength(1);
    const outcome = result.results[0];
    expect(outcome).toBeDefined();
    if (!outcome) return;
    expect(outcome.ok).toBe(true);
    expect(filesystem.calls).toEqual(["searchFiles"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Provider failures surface through the typed error contract
// ---------------------------------------------------------------------------

describe("ProviderError — typed failure contract", () => {
  it("propagates a retryable provider failure as a typed ProviderError", async () => {
    const { provider } = fakeProvider(
      ProviderError.transient(ProviderErrorCode.RateLimited, "slow down"),
    );
    try {
      await runAgentTurn(
        sessionContext(ACTIVE_USER),
        provider,
        { message: "x", tools: [] },
        makeOptions(makeRegistry(), makeFilesystem()),
      );
      expect.unreachable("provider failure must propagate");
    } catch (error) {
      expect(isProviderError(error)).toBe(true);
      const err = error as ProviderError;
      expect(err.code).toBe(ProviderErrorCode.RateLimited);
      expect(err.retryable).toBe(true);
    }
  });

  it("marks permanent failures as non-retryable", () => {
    const err = ProviderError.permanent(
      ProviderErrorCode.Authentication,
      "bad credentials",
    );
    expect(isProviderError(err)).toBe(true);
    expect(err.code).toBe(ProviderErrorCode.Authentication);
    expect(err.retryable).toBe(false);
  });

  it("does not type plain errors as provider errors", () => {
    expect(isProviderError(new Error("boom"))).toBe(false);
    expect(isProviderError("string")).toBe(false);
    expect(isProviderError(null)).toBe(false);
  });

  it("runs no tools when the provider fails", async () => {
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider(
      new ProviderError(ProviderErrorCode.Timeout, "timed out", true),
    );
    await expect(
      runAgentTurn(
        sessionContext(ACTIVE_USER),
        provider,
        { message: "x", tools: [] },
        makeOptions(makeRegistry(), filesystem),
      ),
    ).rejects.toThrow(ProviderError);
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Provider output is re-validated before routing (not trusted)
// ---------------------------------------------------------------------------

describe("AgentProvider — untrusted provider output", () => {
  it("rejects malformed tool-call intents instead of executing them", async () => {
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider({
      toolCalls: [{ id: "a", toolName: "list_directory" }] as AgentToolCall[],
    });

    await expect(
      runAgentTurn(
        sessionContext(ACTIVE_USER),
        provider,
        { message: "x", tools: [] },
        makeOptions(makeRegistry(), filesystem),
      ),
    ).rejects.toThrow(AppError);

    expect(filesystem.calls).toEqual([]);
  });

  it("rejects non-object tool-call intents", async () => {
    const { provider } = fakeProvider({
      toolCalls: [null] as unknown as AgentToolCall[],
    });
    await expect(
      runAgentTurn(
        sessionContext(ACTIVE_USER),
        provider,
        { message: "x", tools: [] },
        makeOptions(makeRegistry(), makeFilesystem()),
      ),
    ).rejects.toThrow(AppError);
  });

  it("rejects an unauthenticated session before executing provider intents", async () => {
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider({
      toolCalls: [call("a", "list_directory", { path: "/home" })],
    });
    await expect(
      runAgentTurn(
        sessionContext(undefined),
        provider,
        { message: "x", tools: [] },
        makeOptions(makeRegistry(), filesystem),
      ),
    ).rejects.toThrow(AppError);
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Policy preserved for provider-produced intents
// ---------------------------------------------------------------------------

describe("AgentProvider — policy preserved", () => {
  it("denies a provider intent for a non-read permission tool", async () => {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    registry.register(writeTool("create_file"));
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider({
      toolCalls: [call("w", "create_file", { path: "/home/new.txt" })],
    });

    const result = await runAgentTurn(
      sessionContext(ACTIVE_USER),
      provider,
      { message: "create a file", tools: [] },
      makeOptions(registry, filesystem),
    );

    expect(result.results).toHaveLength(1);
    const outcome = result.results[0];
    expect(outcome).toBeDefined();
    if (!outcome) return;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.category).toBe("security");
    expect(filesystem.calls).toEqual([]);
  });

  it("denies provider intents for a disabled session user", async () => {
    const filesystem = makeFilesystem();
    const { provider } = fakeProvider({
      toolCalls: [call("c1", "list_directory", { path: "/home" })],
    });
    const result = await runAgentTurn(
      sessionContext(PENDING_USER),
      provider,
      { message: "x", tools: [] },
      makeOptions(makeRegistry(), filesystem),
    );

    const outcome = result.results[0];
    expect(outcome).toBeDefined();
    if (!outcome) return;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.category).toBe("security");
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