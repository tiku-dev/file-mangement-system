/**
 * Agent turn orchestration tests (Phase 10.3).
 *
 * These tests use a FAKE provider only — no real AI provider, no API
 * key, no network access. They prove the orchestration layer:
 *
 *   1. Establishes the authenticated ToolExecutionContext up front and
 *      rejects unauthenticated turns BEFORE the provider is contacted.
 *   2. Sends the instruction + tool metadata to the provider.
 *   3. Routes text-only, tool-call, and mixed responses correctly.
 *   4. Propagates typed provider failures without executing tools.
 *   5. Re-validates provider output and preserves the policy gate.
 */
import { describe, expect, it, vi, type Mock } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerReadTools } from "../tools/definitions/readTools.js";
import { readToolDefinitions } from "../tools/definitions/readTools.js";
import {
  ToolPermission,
  type ToolDefinition,
} from "../tools/types.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import type { AgentToolCall } from "./agent.js";
import type { AgentProvider, AgentResponse } from "./provider.js";
import { isProviderError, ProviderError, ProviderErrorCode } from "./provider.js";
import { orchestrateTurn, type OrchestratedTurnOptions } from "./orchestrator.js";

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

type Generate = AgentProvider["generate"];

/** A fake provider that returns a scripted response or throws a scripted error. */
function fakeProvider(response: AgentResponse | ProviderError): {
  generate: Mock<Generate>;
} {
  const generate = vi.fn<Generate>().mockImplementation(async () => {
    if (isProviderError(response)) throw response;
    return response;
  });
  return { generate };
}

function makeOptions(
  generate: Mock<Generate>,
  override?: Partial<Pick<OrchestratedTurnOptions, "registry" | "filesystem">>,
): OrchestratedTurnOptions {
  return {
    provider: { generate },
    tools: readToolDefinitions,
    registry: override?.registry ?? makeRegistry(),
    filesystem: override?.filesystem ?? makeFilesystem(),
  };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

// ---------------------------------------------------------------------------
// 1. Authentication is preserved at every step
// ---------------------------------------------------------------------------

describe("orchestrateTurn — authentication preserved", () => {
  it("rejects an unauthenticated turn BEFORE the provider is contacted", async () => {
    const { generate } = fakeProvider({ text: "should never be asked" });
    const options = makeOptions(generate);

    await expect(
      orchestrateTurn(sessionContext(undefined), "hello", options),
    ).rejects.toThrow(AppError);

    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated text-only turn too (no tools run)", async () => {
    const { generate } = fakeProvider({ text: "should never be asked" });
    await expect(
      orchestrateTurn(sessionContext(undefined), "hello", makeOptions(generate)),
    ).rejects.toThrow(AppError);
  });

  it("performs the identity check even before routing intents", async () => {
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider({
      toolCalls: [call("a", "list_directory", { path: "/home" })],
    });
    await expect(
      orchestrateTurn(
        sessionContext(undefined),
        "list my home",
        makeOptions(generate, { filesystem }),
      ),
    ).rejects.toThrow(AppError);
    expect(generate).not.toHaveBeenCalled();
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The instruction + tool metadata reach the provider
// ---------------------------------------------------------------------------

describe("orchestrateTurn — provider receives instruction and context", () => {
  it("sends the user instruction and the configured tool metadata", async () => {
    const { generate } = fakeProvider({ text: "ok" });
    await orchestrateTurn(
      sessionContext(ACTIVE_USER),
      "List my home directory",
      makeOptions(generate),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      message: "List my home directory",
      tools: readToolDefinitions,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Response processing: text-only, tool-call, mixed
// ---------------------------------------------------------------------------

describe("orchestrateTurn — response processing", () => {
  it("returns the text for a text-only response and runs no tools", async () => {
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider({ text: "Here is your answer." });
    const result = await orchestrateTurn(
      sessionContext(ACTIVE_USER),
      "hello",
      makeOptions(generate, { filesystem }),
    );

    expect(result.text).toBe("Here is your answer.");
    expect(result.results).toEqual([]);
    expect(filesystem.calls).toEqual([]);
  });

  it("routes tool-call intents through the authenticated pipeline", async () => {
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider({
      toolCalls: [call("a", "list_directory", { path: "/home" })],
    });
    const result = await orchestrateTurn(
      sessionContext(ACTIVE_USER),
      "show /home",
      makeOptions(generate, { filesystem }),
    );

    expect(result.text).toBeUndefined();
    expect(result.results[0]).toEqual({
      ok: true,
      callId: "a",
      data: { path: "/home", parentPath: null, isHome: false, items: [] },
    });
    expect(filesystem.calls).toEqual(["listDirectory:/home"]);
  });

  it("returns the final text plus structured tool results for a mixed response", async () => {
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider({
      text: "I searched for you.",
      toolCalls: [call("t", "search_files", { query: "notes" })],
    });
    const result = await orchestrateTurn(
      sessionContext(ACTIVE_USER),
      "find notes",
      makeOptions(generate, { filesystem }),
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
// 4. Provider failures are typed and never execute tools
// ---------------------------------------------------------------------------

describe("orchestrateTurn — provider failures", () => {
  it("propagates a typed provider failure without executing tools", async () => {
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider(
      ProviderError.transient(ProviderErrorCode.RateLimited, "slow down"),
    );

    await expect(
      orchestrateTurn(
        sessionContext(ACTIVE_USER),
        "do the thing",
        makeOptions(generate, { filesystem }),
      ),
    ).rejects.toThrow(ProviderError);

    expect(filesystem.calls).toEqual([]);
  });

  it("does not retry or loop (no autonomous retries yet)", async () => {
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider(
      new ProviderError(ProviderErrorCode.Timeout, "timed out", true),
    );
    await expect(
      orchestrateTurn(
        sessionContext(ACTIVE_USER),
        "do the thing",
        makeOptions(generate, { filesystem }),
      ),
    ).rejects.toThrow(ProviderError);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Provider output validation and policy are preserved
// ---------------------------------------------------------------------------

describe("orchestrateTurn — validation and policy preserved", () => {
  it("rejects malformed provider intents before executing them", async () => {
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider({
      toolCalls: [{ id: "a", toolName: "list_directory" }] as AgentToolCall[],
    });
    await expect(
      orchestrateTurn(
        sessionContext(ACTIVE_USER),
        "do the thing",
        makeOptions(generate, { filesystem }),
      ),
    ).rejects.toThrow(AppError);
    expect(filesystem.calls).toEqual([]);
  });

  it("denies a provider intent for a non-read permission tool without touching the executor", async () => {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    registry.register(writeTool("create_file"));
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider({
      toolCalls: [call("w", "create_file", { path: "/home/new.txt" })],
    });

    const result = await orchestrateTurn(
      sessionContext(ACTIVE_USER),
      "create a file",
      makeOptions(generate, { registry, filesystem }),
    );

    const outcome = result.results[0];
    expect(outcome).toBeDefined();
    if (!outcome) return;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.category).toBe("security");
    expect(filesystem.calls).toEqual([]);
  });

  it("denies intents for a disabled session user", async () => {
    const filesystem = makeFilesystem();
    const { generate } = fakeProvider({
      toolCalls: [call("c1", "list_directory", { path: "/home" })],
    });
    const result = await orchestrateTurn(
      sessionContext(PENDING_USER),
      "list home",
      makeOptions(generate, { filesystem }),
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