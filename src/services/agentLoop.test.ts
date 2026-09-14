/**
 * Bounded agent tool loop tests (Phase 10.4).
 *
 * These tests use a scripted FAKE provider only — no real AI provider, no
 * API keys, no network access. They prove the loop:
 *
 *   1. Terminates on the provider's final text (no tools executed).
 *   2. Executes tool intents and feeds structured results back as context
 *      for the provider's next round (single- and multi-round).
 *   3. Enforces the configured round limit server-side with a typed
 *      `AgentLoopError` — tools past the limit are NEVER executed.
 *   4. Preserves typed provider failures, authentication, input
 *      validation, and the tool policy on every round.
 *   5. Honors Phase 10.30 SEEDING: `initialToolResults` are shown to the
 *      provider as already-executed first-round context and
 *      `initialToolRounds` count against `maxToolRounds` (so a resumed
 *      approval execution is INSIDE the bound, never outside it).
 */
import { describe, expect, it, vi, type Mock } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerReadTools } from "../tools/definitions/readTools.js";
import { readToolDefinitions } from "../tools/definitions/readTools.js";
import { ToolPermission, type ToolDefinition } from "../tools/types.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import type { AgentToolCall, AgentToolResult } from "./agent.js";
import type { AgentProvider, AgentProviderRequest, AgentResponse } from "./provider.js";
import { isProviderError, ProviderError, ProviderErrorCode } from "./provider.js";
import {
  AgentLoopError,
  isAgentLoopError,
  runAgentLoop,
  type AgentLoopOptions,
} from "./agentLoop.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

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

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  return registry;
}

type Generate = AgentProvider["generate"];

/** A fake provider that serves a scripted list of responses, one per round. */
function scriptedProvider(responses: Array<AgentResponse | ProviderError>): {
  generate: Mock<Generate>;
  requests: AgentProviderRequest[];
} {
  const requests: AgentProviderRequest[] = [];
  const generate = vi.fn<Generate>().mockImplementation(async (request) => {
    requests.push(request);
    const response = responses[requests.length - 1];
    if (response === undefined) {
      throw new Error("fake provider script exhausted");
    }
    if (isProviderError(response)) throw response;
    return response;
  });
  return { generate, requests };
}

function makeOptions(
  generate: Mock<Generate>,
  override?: Partial<
    Pick<
      AgentLoopOptions,
      "registry" | "filesystem" | "maxToolRounds" | "initialToolResults" | "initialToolRounds"
    >
  >,
): AgentLoopOptions {
  return {
    provider: { generate },
    tools: readToolDefinitions,
    registry: override?.registry ?? makeRegistry(),
    filesystem: override?.filesystem ?? makeFilesystem(),
    maxToolRounds: override?.maxToolRounds ?? 3,
    ...(override?.initialToolResults !== undefined
      ? { initialToolResults: override.initialToolResults }
      : {}),
    ...(override?.initialToolRounds !== undefined
      ? { initialToolRounds: override.initialToolRounds }
      : {}),
  };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

function homeListing(path = "/home"): DirectoryListing {
  return { path, parentPath: null, isHome: false, items: [] };
}

// ---------------------------------------------------------------------------
// 1. Termination on final text
// ---------------------------------------------------------------------------

describe("runAgentLoop — final text termination", () => {
  it("returns the text immediately when the provider does not request tools", async () => {
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([{ text: "Hello!" }]);

    const output = await runAgentLoop(
      sessionContext(ACTIVE_USER),
      "hi",
      makeOptions(generate, { filesystem }),
    );

    expect(output).toEqual({
      text: "Hello!",
      results: [],
      toolRounds: 0,
      pendingApprovals: [],
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(requests[0]).toEqual({ message: "hi", tools: readToolDefinitions });
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Tool rounds: single-tool, multi-tool, fed-back context
// ---------------------------------------------------------------------------

describe("runAgentLoop — tool rounds", () => {
  it("executes a single tool round, feeds the result back, and returns final text", async () => {
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([
      { toolCalls: [call("a", "list_directory", { path: "/home" })] },
      { text: "/home is listed." },
    ]);

    const output = await runAgentLoop(
      sessionContext(ACTIVE_USER),
      "list /home",
      makeOptions(generate, { filesystem }),
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(requests[1]).toEqual({
      message: "list /home",
      tools: readToolDefinitions,
      toolResults: [{ ok: true, callId: "a", data: homeListing() }],
    });
    expect(output).toEqual({
      text: "/home is listed.",
      results: [{ ok: true, callId: "a", data: homeListing() }],
      toolRounds: 1,
      pendingApprovals: [],
    });
    expect(filesystem.calls).toEqual(["listDirectory:/home"]);
  });

  it("accumulates results across multiple tool rounds and feeds them back each round", async () => {
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([
      { toolCalls: [call("s", "search_files", { query: "notes" })] },
      { toolCalls: [call("t", "list_directory", { path: "/tmp" })] },
      { text: "All done." },
    ]);

    const output = await runAgentLoop(
      sessionContext(ACTIVE_USER),
      "find notes then list /tmp",
      makeOptions(generate, { filesystem }),
    );

    expect(generate).toHaveBeenCalledTimes(3);
    expect(requests[1]).toEqual({
      message: "find notes then list /tmp",
      tools: readToolDefinitions,
      toolResults: [{ ok: true, callId: "s", data: [] }],
    });
    expect(requests[2]).toEqual({
      message: "find notes then list /tmp",
      tools: readToolDefinitions,
      toolResults: [
        { ok: true, callId: "s", data: [] },
        { ok: true, callId: "t", data: homeListing("/tmp") },
      ],
    });
    expect(output).toEqual({
      text: "All done.",
      results: [
        { ok: true, callId: "s", data: [] },
        { ok: true, callId: "t", data: homeListing("/tmp") },
      ],
      toolRounds: 2,
      pendingApprovals: [],
    });
    expect(filesystem.calls).toEqual(["searchFiles", "listDirectory:/tmp"]);
  });

  it("routes multiple intents within a single round in order", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([
      {
        toolCalls: [
          call("s", "search_files", { query: "notes" }),
          call("t", "list_directory", { path: "/home" }),
        ],
      },
      { text: "Search and listing done." },
    ]);

    const output = await runAgentLoop(
      sessionContext(ACTIVE_USER),
      "search then list",
      makeOptions(generate, { filesystem }),
    );

    expect(output.toolRounds).toBe(1);
    const first = output.results[0];
    const second = output.results[1];
    expect(first).toEqual({ ok: true, callId: "s", data: [] });
    expect(second).toEqual({ ok: true, callId: "t", data: homeListing() });
    expect(filesystem.calls).toEqual(["searchFiles", "listDirectory:/home"]);
  });

  it("invokes the onRound observer once per executed round with the transcript", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([
      { toolCalls: [call("s", "search_files", { query: "notes" })] },
      { toolCalls: [call("t", "list_directory", { path: "/tmp" })] },
      { text: "Everything done." },
    ]);
    const observed: unknown[] = [];

    await runAgentLoop(sessionContext(ACTIVE_USER), "go", {
      ...makeOptions(generate, { filesystem }),
      onRound: (round) => observed.push(round),
    });

    expect(observed).toEqual([
      {
        text: undefined,
        toolCalls: [call("s", "search_files", { query: "notes" })],
        results: [{ ok: true, callId: "s", data: [] }],
        toolRounds: 1,
      },
      {
        text: undefined,
        toolCalls: [call("t", "list_directory", { path: "/tmp" })],
        results: [{ ok: true, callId: "t", data: homeListing("/tmp") }],
        toolRounds: 2,
      },
    ]);
  });

  it("does not call the observer for a text-only turn (no tools executed)", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([{ text: "Hello!" }]);
    const observed: unknown[] = [];

    await runAgentLoop(sessionContext(ACTIVE_USER), "hi", {
      ...makeOptions(generate, { filesystem }),
      onRound: (round) => observed.push(round),
    });

    expect(observed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Server-side round limit
// ---------------------------------------------------------------------------

describe("runAgentLoop — round limit enforced server-side", () => {
  it("ends with a typed error when the provider requests tools past the maximum", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([
      { toolCalls: [call("a", "search_files", { query: "x" })] },
      { toolCalls: [call("b", "search_files", { query: "y" })] },
      { toolCalls: [call("c", "search_files", { query: "z" })] },
    ]);

    let caught: unknown;
    try {
      await runAgentLoop(
        sessionContext(ACTIVE_USER),
        "keep going",
        makeOptions(generate, { filesystem, maxToolRounds: 2 }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentLoopError);
    expect(isAgentLoopError(caught)).toBe(true);
    expect(caught).toMatchObject({
      name: "AgentLoopError",
      code: "agent/max-tool-rounds-reached",
      maxToolRounds: 2,
    });

    expect(generate).toHaveBeenCalledTimes(3);
    // Exactly two tool rounds executed; the over-limit round's tools never ran.
    expect(filesystem.calls).toEqual(["searchFiles", "searchFiles"]);
  });

  it("exposes a stable code and a type guard on the limit error", async () => {
    const error = new AgentLoopError(3);
    expect(error.name).toBe("AgentLoopError");
    expect(error.code).toBe("agent/max-tool-rounds-reached");
    expect(error.maxToolRounds).toBe(3);
    expect(error.message).toContain("3");
    expect(isAgentLoopError(error)).toBe(true);
    expect(isAgentLoopError(new Error("nope"))).toBe(false);
  });

  it("rejects a non-positive maximum as invalid configuration", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([{ text: "never asked" }]);

    await expect(
      runAgentLoop(
        sessionContext(ACTIVE_USER),
        "hi",
        makeOptions(generate, { filesystem, maxToolRounds: 0 }),
      ),
    ).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 4. Provider failures, auth, validation, and policy on every round
// ---------------------------------------------------------------------------

describe("runAgentLoop — failure propagation and guards on every round", () => {
  it("propagates a typed provider failure from a later round without executing further", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([
      { toolCalls: [call("a", "search_files", { query: "x" })] },
      ProviderError.transient(ProviderErrorCode.RateLimited, "slow down"),
    ]);

    await expect(
      runAgentLoop(
        sessionContext(ACTIVE_USER),
        "keep going",
        makeOptions(generate, { filesystem }),
      ),
    ).rejects.toThrow(ProviderError);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(filesystem.calls).toEqual(["searchFiles"]);
  });

  it("rejects an unauthenticated session BEFORE the provider is contacted", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([{ text: "never asked" }]);

    await expect(
      runAgentLoop(sessionContext(undefined), "hello", makeOptions(generate, { filesystem })),
    ).rejects.toThrow(AppError);

    expect(generate).not.toHaveBeenCalled();
    expect(filesystem.calls).toEqual([]);
  });

  it("rejects malformed provider intents on a later round before executing them", async () => {
    const filesystem = makeFilesystem();
    const scripted = scriptedProvider([
      { toolCalls: [call("a", "search_files", { query: "x" })] },
      { toolCalls: [{ id: "b", toolName: "list_directory" }] as AgentToolCall[] },
    ]);

    await expect(
      runAgentLoop(
        sessionContext(ACTIVE_USER),
        "keep going",
        makeOptions(scripted.generate, { filesystem }),
      ),
    ).rejects.toThrow(AppError);

    // Only round one ran; the malformed round executed nothing.
    expect(filesystem.calls).toEqual(["searchFiles"]);
    expect(scripted.generate).toHaveBeenCalledTimes(2);
  });

  it("preserves the tool policy and returns denials as structured results", async () => {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    registry.register(writeTool("create_file"));
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([
      { toolCalls: [call("w", "create_file", { path: "/home/new.txt" })] },
      { text: "I could not create that file." },
    ]);

    const output = await runAgentLoop(
      sessionContext(ACTIVE_USER),
      "create a file",
      makeOptions(generate, { registry, filesystem }),
    );

    const outcome = output.results[0];
    expect(outcome).toBeDefined();
    if (!outcome) return;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.category).toBe("security");

    // The denial was fed back to the provider as context for round two.
    const roundTwo = requests[1];
    expect(roundTwo).toBeDefined();
    if (!roundTwo) return;
    expect(roundTwo.toolResults).toEqual([outcome]);
    expect(filesystem.calls).toEqual([]);
  });

  it("requests round-one context WITHOUT the toolResults field", async () => {
    const { generate, requests } = scriptedProvider([{ text: "no tools needed" }]);
    await runAgentLoop(sessionContext(ACTIVE_USER), "hi", makeOptions(generate));
    const roundOne = requests[0];
    expect(roundOne).toBeDefined();
    if (!roundOne) return;
    expect(roundOne).toEqual({ message: "hi", tools: readToolDefinitions });
    expect("toolResults" in roundOne).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Phase 10.30 seeding: pre-executed context + bound accounting
// ---------------------------------------------------------------------------

describe("runAgentLoop — seeded initial context (Phase 10.30)", () => {
  const seeded: AgentToolResult = { ok: true, callId: "seed", data: homeListing() };

  it("serves seeded results as first-round context and counts them against the bound", async () => {
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([{ text: "already done" }]);

    const output = await runAgentLoop(
      sessionContext(ACTIVE_USER),
      "continue after approval",
      makeOptions(generate, {
        filesystem,
        maxToolRounds: 2,
        initialToolResults: [seeded],
        initialToolRounds: 1,
      }),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(requests[0]).toEqual({
      message: "continue after approval",
      tools: readToolDefinitions,
      toolResults: [seeded],
    });
    expect(output).toEqual({
      text: "already done",
      results: [seeded],
      toolRounds: 1,
      pendingApprovals: [],
    });
    // Seeded results are context, not new executions.
    expect(filesystem.calls).toEqual([]);
  });

  it("enforces the bound from the seeded round count before executing anything new", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([
      { toolCalls: [call("new", "list_directory", { path: "/home" })] },
    ]);

    await expect(
      runAgentLoop(
        sessionContext(ACTIVE_USER),
        "continue after approval",
        makeOptions(generate, {
          filesystem,
          maxToolRounds: 2,
          initialToolResults: [seeded],
          initialToolRounds: 2,
        }),
      ),
    ).rejects.toThrow(AgentLoopError);

    // The provider asked for a third round on a two-round budget: it was
    // asked once and answered, then the loop refused the new tool WITHOUT
    // executing it.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(filesystem.calls).toEqual([]);
  });

  it("rejects a negative initialToolRounds as invalid configuration", async () => {
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([{ text: "never asked" }]);

    await expect(
      runAgentLoop(
        sessionContext(ACTIVE_USER),
        "hi",
        makeOptions(generate, {
          filesystem,
          maxToolRounds: 2,
          initialToolResults: [seeded],
          initialToolRounds: -1,
        }),
      ),
    ).rejects.toThrow(TypeError);
  });
});

function writeTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool (synthetic test fixture only).`,
    inputSchema: { type: "object" },
    permission: ToolPermission.Write,
  };
}
