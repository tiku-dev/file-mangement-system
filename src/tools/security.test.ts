/**
 * Tool-layer security properties — no arbitrary execution (Phase 10.35).
 *
 * These tests pin the boundary guarantees the tool runtime relies on:
 *
 *   - Tool dispatch is a CLOSED, FROZEN function map keyed by exact registered
 *     names. There is no `eval`, no `Function`, no dynamic import, and no
 *     shell — a hostile or mangled tool name can never conjure a function to
 *     run.
 *   - Unknown names and names that LOOK like commands/modules are rejected as
 *     structured `unknown_tool` results and never touch the filesystem.
 *   - A name mechanically registered into the registry but absent from the
 *     handler map still cannot execute anything: dispatch returns a structured
 *     `internal` (handler-missing) failure and the executor is never reached.
 *
 * A minimal recording `FilesystemExecutor` stands in for Tauri/Rust; no real
 * I/O, no LLM, no Node `fs`.
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry.js";
import { registerReadTools } from "./definitions/readTools.js";
import { dispatchTool, handlers, handledToolNames } from "./handlers/index.js";
import { ToolErrorCode } from "./errors.js";
import { ToolPermission, type ToolDefinition } from "./types.js";
import { authenticatedAiAgent } from "./policy.js";
import type { FilesystemExecutor } from "./executor.js";

interface ExecutorCalls {
  listDirectory: string[];
  searchFiles: string[];
  getFileMetadata: string[];
  readFile: string[];
  moveFile: Array<{ source: string; destination: string }>;
}

function makeRecordingExecutor(): FilesystemExecutor & { calls: ExecutorCalls } {
  const calls: ExecutorCalls = {
    listDirectory: [],
    searchFiles: [],
    getFileMetadata: [],
    readFile: [],
    moveFile: [],
  };
  return {
    calls,
    async listDirectory(path) {
      calls.listDirectory.push(path);
      return { path, parentPath: null, isHome: false, items: [] };
    },
    async searchFiles(query) {
      calls.searchFiles.push(query);
      return [];
    },
    async getFileMetadata(path) {
      calls.getFileMetadata.push(path);
      return {
        name: path,
        path,
        isFile: true,
        isFolder: false,
        sizeBytes: 0,
        extension: null,
        isHidden: false,
        modified: "\u2014",
        modifiedTs: 0,
        created: "\u2014",
        createdTs: 0,
        accessed: null,
        accessedTs: null,
      };
    },
    async readFile(path) {
      calls.readFile.push(path);
      return { encoding: "base64", data: "" };
    },
    async moveFile(source, destination) {
      calls.moveFile.push({ source, destination });
    },
  };
}

function executionContext() {
  return {
    actor: authenticatedAiAgent({
      id: "00000000-0000-0000-0000-000000000001",
      email: "test@example.com",
      displayName: "Test User",
      status: "active",
    }),
  };
}

function assertNoFilesystemTouch(calls: ExecutorCalls): void {
  expect(calls.listDirectory).toEqual([]);
  expect(calls.searchFiles).toEqual([]);
  expect(calls.getFileMetadata).toEqual([]);
  expect(calls.readFile).toEqual([]);
  expect(calls.moveFile).toEqual([]);
}

describe("no arbitrary command/code execution path", () => {
  it("the handler surface is a closed frozen map of exactly the known tools", () => {
    expect(Object.isFrozen(handlers)).toBe(true);
    expect([...handledToolNames].sort()).toEqual([
      "get_file_metadata",
      "list_directory",
      "move_file",
      "read_file",
      "search_files",
    ]);
    // No surface that could shadow an execution primitive.
    for (const hostile of ["eval", "Function", "exec", "spawn", "require", "import"]) {
      expect(
        (handlers as unknown as Record<string, unknown>)[hostile],
      ).toBeUndefined();
    }
  });

  it.each([
    "eval",
    "Function",
    "exec",
    "execSync",
    "spawn",
    "spawn_sync",
    "require",
    "import",
    "child_process",
    "shell",
    "system",
    "run",
    "sudo",
    "process.exit",
    "list_directory;rm -rf /",
    "list_directory && curl http://evil",
    "read_file --help",
    "../..",
    "",
  ])("rejects hostile tool name %j as unknown_tool and never touches the filesystem", async (name) => {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    const executor = makeRecordingExecutor();

    const result = await dispatchTool(
      registry,
      name,
      {},
      { filesystem: executor },
      executionContext(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("unknown_tool");
    expect(result.error.code).toBe(ToolErrorCode.UnknownTool);
    expect(result.error.status).toBe(400);
    assertNoFilesystemTouch(executor.calls);
  });

  it("a registry-registered name with NO handler cannot execute anything", async () => {
    // Mechanical proof: even if a definition named "eval" is placed in the
    // registry, dispatch has NO machinery to turn that name into a function —
    // handlers is a closed map; there is no eval/Function/dynamic import.
    const registry = new ToolRegistry();
    registerReadTools(registry);
    const hostile: ToolDefinition = {
      name: "eval",
      description: "hostile definition that must not run anything",
      inputSchema: { type: "object", properties: {}, required: [] },
      permission: ToolPermission.Read,
    };
    registry.register(hostile);
    const executor = makeRecordingExecutor();

    const result = await dispatchTool(
      registry,
      "eval",
      {},
      { filesystem: executor },
      executionContext(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The tool is REGISTERED (registry gate passes) but has no handler → a
    // structured internal "handler-missing" failure. Nothing runs.
    expect(result.error.category).toBe("internal");
    expect(result.error.code).toBe(ToolErrorCode.HandlerMissing);
    assertNoFilesystemTouch(executor.calls);
  });

  it("exact-name lookup rejects near-misses (no fuzzy resolution)", async () => {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    const executor = makeRecordingExecutor();

    for (const name of ["list_directory2", "List_Directory", "list_directory "]) {
      const result = await dispatchTool(
        registry,
        name,
        { path: "/home" },
        { filesystem: executor },
        executionContext(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.category).toBe("unknown_tool");
    }
    assertNoFilesystemTouch(executor.calls);
  });

  it("only the exact registered list_directory reaches the executor", async () => {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    const executor = makeRecordingExecutor();

    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      { filesystem: executor },
      executionContext(),
    );

    expect(result.ok).toBe(true);
    expect(executor.calls.listDirectory).toEqual(["/home"]);
    expect(executor.calls.readFile).toEqual([]);
    expect(executor.calls.searchFiles).toEqual([]);
    expect(executor.calls.getFileMetadata).toEqual([]);
  });
});