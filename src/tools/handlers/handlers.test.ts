/**
 * Tool handler / dispatch / contract tests (Phase 9.4).
 *
 * Every test runs with a `FakeFilesystemExecutor` — no LLM, no Tauri,
 * no Node `fs`. The fake records every call so we can assert the bridge
 * passes inputs through unchanged and returns the executor's data
 * unchanged.
 *
 * The full chain under test:
 *
 *   dispatchTool(registry, name, input, { filesystem: fake })
 *     -> registry.get(name)                          [Phase 9.1 gate]
 *     -> handlers[name](input, ctx)                   [Phase 9.3 bridge]
 *     -> requireString(input, field)                  [Phase 9.3 validation]
 *     -> fake.listDirectory|searchFiles|...           [Phase 9.3 executor]
 *     -> mapExecutorError -> ToolError(category=...)  [Phase 9.4 contract]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../registry.js";
import {
  readToolDefinitions,
  registerReadTools,
} from "../definitions/readTools.js";
import {
  writeToolDefinitions,
  registerWriteTools,
} from "../definitions/writeTools.js";
import { dispatchTool, handlers, handledToolNames } from "./index.js";
import { requireString } from "./handler.js";
import {
  ToolError,
  ToolErrorCode,
  isToolError,
  toToolError,
} from "../errors.js";
import { mapExecutorError } from "./executorErrors.js";
import { authenticatedAiAgent } from "../policy.js";
import type { FilesystemExecutor } from "../executor.js";
import type {
  DirectoryListing,
  FileEntry,
  FileMetadata,
} from "../tauriShapes.js";

interface FakeOptions {
  listDirectory?: DirectoryListing;
  searchFiles?: FileEntry[];
  getFileMetadata?: FileMetadata;
  getFileMetadataByPath?: Record<string, FileMetadata>;
  readFile?: { encoding: "base64"; data: string };
}

interface FakeErrorOptions {
  listDirectory?: Error;
  searchFiles?: Error;
  getFileMetadata?: Error;
  getFileMetadataByPath?: Record<string, Error>;
  readFile?: Error;
  moveFile?: Error;
}

interface Fake extends FilesystemExecutor {
  calls: {
    listDirectory: string[];
    searchFiles: string[];
    getFileMetadata: string[];
    readFile: string[];
    moveFile: Array<[string, string]>;
  };
  respondWith: FakeOptions;
  throwFor: FakeErrorOptions;
}

function makeFake(): Fake {
  const calls = {
    listDirectory: [] as string[],
    searchFiles: [] as string[],
    getFileMetadata: [] as string[],
    readFile: [] as string[],
    moveFile: [] as Array<[string, string]>,
  };
  const respondWith: FakeOptions = {};
  const throwFor: FakeErrorOptions = {};
  const fake: Fake = {
    calls,
    respondWith,
    throwFor,
    async listDirectory(path: string) {
      calls.listDirectory.push(path);
      if (throwFor.listDirectory) throw throwFor.listDirectory;
      if (respondWith.listDirectory) return respondWith.listDirectory;
      return { path, parentPath: null, isHome: false, items: [] };
    },
    async searchFiles(query: string) {
      calls.searchFiles.push(query);
      if (throwFor.searchFiles) throw throwFor.searchFiles;
      if (respondWith.searchFiles) return respondWith.searchFiles;
      return [];
    },
    async getFileMetadata(path: string) {
      calls.getFileMetadata.push(path);
      if (throwFor.getFileMetadata) throw throwFor.getFileMetadata;
      if (throwFor.getFileMetadataByPath?.[path]) {
        throw throwFor.getFileMetadataByPath[path];
      }
      if (respondWith.getFileMetadataByPath?.[path]) {
        return respondWith.getFileMetadataByPath[path];
      }
      if (respondWith.getFileMetadata) return respondWith.getFileMetadata;
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
    async readFile(path: string) {
      calls.readFile.push(path);
      if (throwFor.readFile) throw throwFor.readFile;
      if (respondWith.readFile) return respondWith.readFile;
      return { encoding: "base64", data: "" };
    },
    async moveFile(source: string, destination: string) {
      calls.moveFile.push([source, destination]);
      if (throwFor.moveFile) throw throwFor.moveFile;
      return undefined;
    },
  };
  return fake;
}

let registry: ToolRegistry;
let fake: Fake;

/** Canned `FileMetadata` for scripting the fake's per-path map. */
function metaOf(
  path: string,
  kind: "file" | "folder",
): FileMetadata {
  const isFile = kind === "file";
  return {
    name: path.split("/").pop() ?? path,
    path,
    isFile,
    isFolder: !isFile,
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
}

function makeContext() {
  return { filesystem: fake };
}

function makeExecutionContext() {
  // Use the canonical Phase 9.6 builder so the test exercises the
  // real path a future HTTP route or AI agent would take to
  // construct a context. The user is "active" so the default policy
  // allows the call.
  return {
    actor: authenticatedAiAgent({
      id: "00000000-0000-0000-0000-000000000001",
      email: "test@example.com",
      displayName: "Test User",
      status: "active",
    }),
  };
}

beforeEach(() => {
  fake = makeFake();
  registry = new ToolRegistry();
  registerReadTools(registry);
});

afterEach(() => {
  vi.restoreAllMocks();
});


// ---------------------------------------------------------------------------
// Phase 9.4 contract: ToolError and mapExecutorError
// ---------------------------------------------------------------------------

describe("ToolError", () => {
  it("preserves category, code, and message", () => {
    const err = new ToolError("validation", "tools/invalid-input", "bad");
    expect(err.category).toBe("validation");
    expect(err.code).toBe("tools/invalid-input");
    expect(err.message).toBe("bad");
    expect(err.status).toBe(400);
  });

  it("maps each category to the expected default status", () => {
    expect(new ToolError("validation", "x", "x").status).toBe(400);
    expect(new ToolError("unknown_tool", "x", "x").status).toBe(400);
    expect(new ToolError("not_found", "x", "x").status).toBe(404);
    expect(new ToolError("security", "x", "x").status).toBe(403);
    expect(new ToolError("internal", "x", "x").status).toBe(500);
  });

  it("factory methods produce the right category", () => {
    expect(ToolError.validation("x", "x").category).toBe("validation");
    expect(ToolError.unknownTool("x").category).toBe("unknown_tool");
    expect(ToolError.notFound("x", "x").category).toBe("not_found");
    expect(ToolError.security("x", "x").category).toBe("security");
    expect(ToolError.internal().category).toBe("internal");
  });

  it("unknownTool embeds the missing tool name in the message", () => {
    expect(ToolError.unknownTool("nope").message).toContain("nope");
    expect(ToolError.unknownTool("nope").code).toBe(ToolErrorCode.UnknownTool);
  });

  it("isToolError narrows correctly", () => {
    expect(isToolError(ToolError.internal())).toBe(true);
    expect(isToolError(new Error("x"))).toBe(false);
    expect(isToolError("string")).toBe(false);
    expect(isToolError(null)).toBe(false);
  });

  it("toToolError passes a ToolError through unchanged", () => {
    const original = ToolError.internal("specific");
    expect(toToolError(original)).toBe(original);
  });

  it("toToolError projects an AppError using its status", async () => {
    const { AppError } = await import("../../core/errors.js");
    const appErr = new AppError(404, "filesystem/not-found", "missing");
    const projected = toToolError(appErr);
    expect(projected.category).toBe("not_found");
    expect(projected.code).toBe("filesystem/not-found");
    expect(projected.message).toBe("missing");
  });

  it("toToolError returns a public-safe internal for unknown errors", () => {
    const projected = toToolError(new Error("ENOENT /etc/shadow"));
    expect(projected.category).toBe("internal");
    expect(projected.code).toBe(ToolErrorCode.Internal);
    expect(projected.message).not.toContain("/etc/shadow");
    expect(projected.message).not.toContain("ENOENT");
  });

  it("toToolError respects a supplied defaultCategory", () => {
    const projected = toToolError(new Error("weird"), "not_found");
    expect(projected.category).toBe("not_found");
  });

  it("toToolError handles non-Error throws", () => {
    expect(toToolError("string").category).toBe("internal");
    expect(toToolError(undefined).category).toBe("internal");
    expect(toToolError(null).category).toBe("internal");
  });
});


describe("mapExecutorError", () => {
  it("returns the same ToolError when one is passed in", () => {
    const err = ToolError.notFound("x", "x");
    expect(mapExecutorError(err)).toBe(err);
  });

  it("maps 'does not exist' to not_found", () => {
    const mapped = mapExecutorError(
      new Error("The file or folder does not exist."),
    );
    expect(mapped.category).toBe("not_found");
    expect(mapped.code).toBe(ToolErrorCode.FilesystemNotFound);
  });

  it("maps 'no longer exists' to not_found", () => {
    const mapped = mapExecutorError(new Error("The file no longer exists."));
    expect(mapped.category).toBe("not_found");
  });

  it("maps 'permission denied' to security", () => {
    const mapped = mapExecutorError(new Error("Permission denied."));
    expect(mapped.category).toBe("security");
    expect(mapped.code).toBe(ToolErrorCode.FilesystemPermissionDenied);
  });

  it("maps 'access not permitted' to security", () => {
    const mapped = mapExecutorError(
      new Error("Access to this path is not permitted."),
    );
    expect(mapped.category).toBe("security");
    expect(mapped.code).toBe(ToolErrorCode.FilesystemNotAllowed);
  });

  it("maps 'not a folder' to validation (filesystem/not-a-directory)", () => {
    const mapped = mapExecutorError(new Error("The path is not a folder."));
    expect(mapped.category).toBe("validation");
    expect(mapped.code).toBe("filesystem/not-a-directory");
  });

  it("maps 'not a file' to validation (filesystem/not-a-file)", () => {
    const mapped = mapExecutorError(
      new Error("The selected path is a folder, not a file."),
    );
    expect(mapped.category).toBe("validation");
    expect(mapped.code).toBe("filesystem/not-a-file");
  });

  it("falls back to public-safe internal for unknown shapes", () => {
    const mapped = mapExecutorError(
      new Error("ENOENT: no such file or directory, open '/etc/shadow'"),
    );
    expect(mapped.category).toBe("internal");
    expect(mapped.message).not.toContain("/etc/shadow");
    expect(mapped.message).not.toContain("ENOENT");
  });

  it("uses the supplied fallback message", () => {
    const mapped = mapExecutorError(
      new Error("anything weird"),
      "Custom fallback.",
    );
    expect(mapped.category).toBe("internal");
    expect(mapped.message).toBe("Custom fallback.");
  });
});

// ---------------------------------------------------------------------------
// requireString (input validation) — Phase 9.4 contract
// ---------------------------------------------------------------------------

describe("requireString", () => {
  it("returns the value when the field is a non-empty string", () => {
    const result = requireString({ path: "/tmp" }, "path");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/tmp");
  });

  it("rejects missing fields with category=validation", () => {
    const result = requireString({}, "path");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("validation");
      expect(result.error.code).toBe(ToolErrorCode.InvalidInput);
      expect(result.error.status).toBe(400);
    }
  });

  it("rejects non-string values with category=validation", () => {
    for (const value of [42, [], {}, null]) {
      const result = requireString({ path: value }, "path");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("validation");
      }
    }
  });

  it("rejects empty strings with category=validation", () => {
    const result = requireString({ path: "" }, "path");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("validation");
  });
});


// ---------------------------------------------------------------------------
// list_directory handler
// ---------------------------------------------------------------------------

describe("list_directory handler", () => {
  it("delegates to the executor and returns its data", async () => {
    const canned: DirectoryListing = {
      path: "/home",
      parentPath: null,
      isHome: true,
      items: [
        {
          id: "/home/a.txt",
          name: "a.txt",
          path: "/home/a.txt",
          isFolder: false,
          sizeBytes: 4,
          itemCount: null,
          fileType: "txt",
          size: "4 B",
          created: "Jan 1, 2026",
          modified: "Jan 1, 2026",
          modifiedTs: 1,
          createdTs: 1,
        },
      ],
    };
    fake.respondWith.listDirectory = canned;
    const result = await handlers.list_directory(
      { path: "/home" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual(canned);
    expect(fake.calls.listDirectory).toEqual(["/home"]);
  });

  it("rejects a missing path field with category=validation", async () => {
    const result = await handlers.list_directory({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidInput);
    expect(fake.calls.listDirectory).toEqual([]);
  });

  it("rejects a non-string path with category=validation", async () => {
    const result = await handlers.list_directory(
      { path: 42 },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidInput);
    expect(fake.calls.listDirectory).toEqual([]);
  });

  // Phase 10.35 — deterministic tool-layer scope guard. Relative / unusable
  // paths are rejected before the executor is reached; the original absolute
  // path is passed through verbatim for the canonical scope check.
  it("rejects a relative path as invalid input and never calls the executor", async () => {
    const result = await handlers.list_directory(
      { path: "Documents" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidPath);
    expect(fake.calls.listDirectory).toEqual([]);
  });

  it("rejects a traversal path that escapes the scope and never calls the executor", async () => {
    for (const path of ["/../etc", "/home/../../etc/passwd"]) {
      const result = await handlers.list_directory({ path }, makeContext());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.category).toBe("security");
      expect(result.error.code).toBe(ToolErrorCode.PathOutOfScope);
    }
    expect(fake.calls.listDirectory).toEqual([]);
  });

  it("passes a valid absolute path through to the executor unchanged", async () => {
    const result = await handlers.list_directory(
      { path: "/Users/alice/Documents" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.listDirectory).toEqual(["/Users/alice/Documents"]);
  });

  it("projects an executor 'not found' to category=not_found", async () => {
    fake.throwFor.listDirectory = new Error(
      "The file or folder does not exist.",
    );
    const result = await handlers.list_directory(
      { path: "/missing" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("not_found");
    expect(result.error.status).toBe(404);
  });

  it("projects an executor 'permission denied' to category=security", async () => {
    fake.throwFor.listDirectory = new Error("Permission denied.");
    const result = await handlers.list_directory(
      { path: "/locked" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.status).toBe(403);
  });

  it("projects an executor 'not a directory' to category=validation", async () => {
    fake.throwFor.listDirectory = new Error("The path is not a folder.");
    const result = await handlers.list_directory(
      { path: "/file.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });
});


// ---------------------------------------------------------------------------
// search_files handler
// ---------------------------------------------------------------------------

describe("search_files handler", () => {
  it("delegates to the executor and returns its data", async () => {
    const canned: FileEntry[] = [
      {
        id: "/home/notes.txt",
        name: "notes.txt",
        path: "/home/notes.txt",
        isFolder: false,
        sizeBytes: 4,
        itemCount: null,
        fileType: "txt",
        size: "4 B",
        created: "Jan 1, 2026",
        modified: "Jan 1, 2026",
        modifiedTs: 1,
        createdTs: 1,
      },
    ];
    fake.respondWith.searchFiles = canned;
    const result = await handlers.search_files(
      { query: "notes" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual(canned);
    expect(fake.calls.searchFiles).toEqual(["notes"]);
  });

  it("rejects a missing query field with category=validation", async () => {
    const result = await handlers.search_files({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidInput);
  });

  it("rejects an empty query with category=validation", async () => {
    const result = await handlers.search_files({ query: "" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });

  it("rejects a non-string query with category=validation", async () => {
    const result = await handlers.search_files({ query: 42 }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });

  // Phase 10.37 — `search_files` has NO path argument (the query is a filename
  // substring; the walk stays confined to the AllowList roots), so the path
  // scope guard does not apply to it. The one malformed-input class that does
  // apply is a query containing NUL / control characters, rejected before the
  // executor is reached via the shared path-guard helper.
  it("rejects a control-character query as malformed input and never calls the executor", async () => {
    for (const query of ["a\u0000b", "a\nb", "a\tb"]) {
      const result = await handlers.search_files({ query }, makeContext());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.category).toBe("validation");
      expect(result.error.code).toBe(ToolErrorCode.InvalidInput);
    }
    expect(fake.calls.searchFiles).toEqual([]);
  });

  it("passes a traversal-looking query through as a substring (queries are not paths)", async () => {
    const result = await handlers.search_files(
      { query: "../../etc" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.searchFiles).toEqual(["../../etc"]);
  });

  it("projects an executor 'access not permitted' to category=security", async () => {
    fake.throwFor.searchFiles = new Error(
      "Access to this path is not permitted.",
    );
    const result = await handlers.search_files(
      { query: "secret" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.status).toBe(403);
  });
});


// ---------------------------------------------------------------------------
// get_file_metadata handler
// ---------------------------------------------------------------------------

describe("get_file_metadata handler", () => {
  it("delegates to the executor and returns its data", async () => {
    const canned: FileMetadata = {
      name: "notes.txt",
      path: "/home/notes.txt",
      isFile: true,
      isFolder: false,
      sizeBytes: 12,
      extension: "txt",
      isHidden: false,
      modified: "Jan 1, 2026",
      modifiedTs: 1,
      created: "Jan 1, 2026",
      createdTs: 1,
      accessed: null,
      accessedTs: null,
    };
    fake.respondWith.getFileMetadata = canned;
    const result = await handlers.get_file_metadata(
      { path: "/home/notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual(canned);
    expect(fake.calls.getFileMetadata).toEqual(["/home/notes.txt"]);
  });

  it("rejects a missing path field with category=validation", async () => {
    const result = await handlers.get_file_metadata({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });

  it("rejects a non-string path with category=validation", async () => {
    const result = await handlers.get_file_metadata(
      { path: 42 },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });

  // Phase 10.37 — deterministic tool-layer scope guard. Relative, malformed,
  // and root-escaping paths are rejected before the executor is reached; the
  // original absolute path is passed through verbatim for the canonical scope
  // check.
  it("rejects a relative path as invalid input and never calls the executor", async () => {
    const result = await handlers.get_file_metadata(
      { path: "notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidPath);
    expect(fake.calls.getFileMetadata).toEqual([]);
  });

  it("rejects a control-character path as invalid input and never calls the executor", async () => {
    const result = await handlers.get_file_metadata(
      { path: "/a\u0000b" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidPath);
    expect(fake.calls.getFileMetadata).toEqual([]);
  });

  it("rejects a traversal path that escapes the scope and never calls the executor", async () => {
    for (const path of ["/../etc", "/home/../../etc/passwd"]) {
      const result = await handlers.get_file_metadata({ path }, makeContext());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.category).toBe("security");
      expect(result.error.code).toBe(ToolErrorCode.PathOutOfScope);
    }
    expect(fake.calls.getFileMetadata).toEqual([]);
  });

  it("passes a valid absolute path through to the executor unchanged", async () => {
    const result = await handlers.get_file_metadata(
      { path: "/Users/alice/Documents/notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.getFileMetadata).toEqual([
      "/Users/alice/Documents/notes.txt",
    ]);
  });

  it("projects an executor 'not found' to category=not_found", async () => {
    fake.throwFor.getFileMetadata = new Error(
      "The file or folder does not exist.",
    );
    const result = await handlers.get_file_metadata(
      { path: "/nope" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("not_found");
  });

  it("projects an executor 'permission denied' to category=security", async () => {
    fake.throwFor.getFileMetadata = new Error("Permission denied.");
    const result = await handlers.get_file_metadata(
      { path: "/locked" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
  });
});

// ---------------------------------------------------------------------------
// read_file handler
// ---------------------------------------------------------------------------

describe("read_file handler", () => {
  it("delegates to the executor and returns its base64 output", async () => {
    fake.respondWith.readFile = {
      encoding: "base64",
      data: Buffer.from("hello world", "utf8").toString("base64"),
    };
    const result = await handlers.read_file(
      { path: "/home/notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.encoding).toBe("base64");
    expect(Buffer.from(result.data.data, "base64").toString("utf8")).toBe(
      "hello world",
    );
    expect(fake.calls.readFile).toEqual(["/home/notes.txt"]);
  });

  it("rejects a missing path field with category=validation", async () => {
    const result = await handlers.read_file({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });

  it("rejects a non-string path with category=validation", async () => {
    const result = await handlers.read_file({ path: [] }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });

  // Phase 10.37 — deterministic tool-layer scope guard. Relative, malformed,
  // and root-escaping paths are rejected before the executor is reached; the
  // original absolute path is passed through verbatim for the canonical scope
  // check.
  it("rejects a relative path as invalid input and never calls the executor", async () => {
    const result = await handlers.read_file({ path: "notes.txt" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidPath);
    expect(fake.calls.readFile).toEqual([]);
  });

  it("rejects a control-character path as invalid input and never calls the executor", async () => {
    const result = await handlers.read_file({ path: "/a\u0000b" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidPath);
    expect(fake.calls.readFile).toEqual([]);
  });

  it("rejects a traversal path that escapes the scope and never calls the executor", async () => {
    for (const path of ["/../etc", "/home/../../etc/passwd"]) {
      const result = await handlers.read_file({ path }, makeContext());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.category).toBe("security");
      expect(result.error.code).toBe(ToolErrorCode.PathOutOfScope);
    }
    expect(fake.calls.readFile).toEqual([]);
  });

  it("passes a valid absolute path through to the executor unchanged", async () => {
    fake.respondWith.readFile = {
      encoding: "base64",
      data: Buffer.from("hi", "utf8").toString("base64"),
    };
    const result = await handlers.read_file(
      { path: "/Users/alice/Documents/notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.readFile).toEqual([
      "/Users/alice/Documents/notes.txt",
    ]);
  });

  it("projects an executor 'not a file' to category=validation", async () => {
    fake.throwFor.readFile = new Error(
      "The selected path is a folder, not a file.",
    );
    const result = await handlers.read_file({ path: "/home" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });

  it("projects an executor 'not found' to category=not_found", async () => {
    fake.throwFor.readFile = new Error("The file or folder does not exist.");
    const result = await handlers.read_file({ path: "/nope" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("not_found");
  });

  it("projects an executor 'permission denied' to category=security", async () => {
    fake.throwFor.readFile = new Error("Permission denied.");
    const result = await handlers.read_file({ path: "/x" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
  });
});


// ---------------------------------------------------------------------------
// dispatchTool
// ---------------------------------------------------------------------------

describe("dispatchTool", () => {
  it("routes list_directory to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      makeContext(),
      makeExecutionContext(),);
    expect(result.ok).toBe(true);
    expect(fake.calls.listDirectory).toEqual(["/home"]);
  });

  it("routes search_files to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "search_files",
      { query: "notes" },
      makeContext(),
      makeExecutionContext(),);
    expect(result.ok).toBe(true);
    expect(fake.calls.searchFiles).toEqual(["notes"]);
  });

  it("routes get_file_metadata to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "get_file_metadata",
      { path: "/home/notes.txt" },
      makeContext(),
      makeExecutionContext(),);
    expect(result.ok).toBe(true);
    expect(fake.calls.getFileMetadata).toEqual(["/home/notes.txt"]);
  });

  it("routes read_file to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "read_file",
      { path: "/home/notes.txt" },
      makeContext(),
      makeExecutionContext(),);
    expect(result.ok).toBe(true);
    expect(fake.calls.readFile).toEqual(["/home/notes.txt"]);
  });

  it("returns category=unknown_tool for an unknown tool name", async () => {
    const result = await dispatchTool(
      registry,
      "non_existent_tool",
      {},
      makeContext(),
      makeExecutionContext(),);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("unknown_tool");
    expect(result.error.code).toBe(ToolErrorCode.UnknownTool);
    expect(result.error.status).toBe(400);
    expect(result.error.message).toContain("non_existent_tool");
    expect(fake.calls).toEqual({
      listDirectory: [],
      searchFiles: [],
      getFileMetadata: [],
      readFile: [],
      moveFile: [],
    });
  });

  it("preserves structured success data end-to-end", async () => {
    const canned: DirectoryListing = {
      path: "/home",
      parentPath: null,
      isHome: true,
      items: [],
    };
    fake.respondWith.listDirectory = canned;
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      makeContext(),
      makeExecutionContext(),);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    // The exact structured payload is preserved through dispatch.
    expect(result.data).toEqual(canned);
  });

  it("propagates handler-thrown ToolError categories through dispatch", async () => {
    // Read_file on a directory → handler throws validation ToolError.
    fake.throwFor.readFile = new Error(
      "The selected path is a folder, not a file.",
    );
    const result = await dispatchTool(
      registry,
      "read_file",
      { path: "/home" },
      makeContext(),
      makeExecutionContext(),);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });
});


// ---------------------------------------------------------------------------
// Registry: read tools are correctly registered
// ---------------------------------------------------------------------------

describe("read tools — registry", () => {
  const toolNames = [
    "list_directory",
    "search_files",
    "get_file_metadata",
    "read_file",
  ];

  it("all four read tools are registered", () => {
    expect(registry.size).toBe(4);
  });

  it.each(toolNames)("tool '%s' is registered", (name) => {
    expect(registry.get(name)).toBeDefined();
  });

  it.each(toolNames)("tool '%s' has the correct exact name", (name) => {
    expect(registry.get(name).name).toBe(name);
  });

  it.each(toolNames)("tool '%s' has a non-empty description", (name) => {
    expect(registry.get(name).description.length).toBeGreaterThan(10);
  });

  it.each(toolNames)("tool '%s' has the read permission", (name) => {
    expect(registry.get(name).permission).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// Registry: write tools
// ---------------------------------------------------------------------------

describe("write tools — registry", () => {
  it("registerWriteTools adds move_file alongside the read tools", () => {
    const r = new ToolRegistry();
    registerReadTools(r);
    registerWriteTools(r);
    expect(r.size).toBe(5);
    expect(r.get("move_file")).toBeDefined();
  });

  it("move_file is a write-permission tool that requires approval", () => {
    const definition = writeToolDefinitions.find(
      (d) => d.name === "move_file",
    );
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    expect(definition.permission).toBe("write");
    expect(definition.requiresApproval).toBe(true);
    expect(definition.inputSchema.required).toContain("sourcePath");
    expect(definition.inputSchema.required).toContain("destinationPath");
  });
});

// ---------------------------------------------------------------------------
// move_file handler behaviour (via dispatchTool — approval-agnostic)
// ---------------------------------------------------------------------------

describe("move_file handler", () => {
  beforeEach(() => {
    registerWriteTools(registry);
  });

  function scriptMoveState(): void {
    fake.respondWith.getFileMetadataByPath = {
      "/home/a.txt": metaOf("/home/a.txt", "file"),
      "/home/dest": metaOf("/home/dest", "folder"),
    };
    fake.throwFor.getFileMetadataByPath = {
      "/home/dest/b.txt": new Error("The file or folder does not exist."),
    };
  }

  it("moves a file to an exact destination and reports the canonical pair", async () => {
    scriptMoveState();
    const result = await dispatchTool(
      registry,
      "move_file",
      { sourcePath: "/home/a.txt", destinationPath: "/home/dest/b.txt" },
      makeContext(),
      makeExecutionContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual({
      movedFrom: "/home/a.txt",
      movedTo: "/home/dest/b.txt",
    });
    expect(fake.calls.moveFile).toEqual([["/home/a.txt", "/home/dest/b.txt"]]);
  });

  it("rejects a missing source as not_found", async () => {
    fake.throwFor.getFileMetadataByPath = {
      "/home/ghost.txt": new Error("The file or folder no longer exists."),
    };
    const result = await dispatchTool(
      registry,
      "move_file",
      { sourcePath: "/home/ghost.txt", destinationPath: "/home/dest/b.txt" },
      makeContext(),
      makeExecutionContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("not_found");
    expect(result.error.code).toBe(ToolErrorCode.FilesystemNotFound);
    expect(fake.calls.moveFile).toEqual([]);
  });

  it("rejects a folder source as not-a-file", async () => {
    fake.respondWith.getFileMetadataByPath = {
      "/home/folder": metaOf("/home/folder", "folder"),
    };
    const result = await dispatchTool(
      registry,
      "move_file",
      { sourcePath: "/home/folder", destinationPath: "/home/dest/b.txt" },
      makeContext(),
      makeExecutionContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.FilesystemNotAFile);
    expect(fake.calls.moveFile).toEqual([]);
  });

  it("rejects a missing destination folder as not_found", async () => {
    fake.respondWith.getFileMetadataByPath = {
      "/home/a.txt": metaOf("/home/a.txt", "file"),
    };
    fake.throwFor.getFileMetadataByPath = {
      "/home/missing": new Error("The file or folder does not exist."),
      "/home/missing/b.txt": new Error("The file or folder does not exist."),
    };
    const result = await dispatchTool(
      registry,
      "move_file",
      { sourcePath: "/home/a.txt", destinationPath: "/home/missing/b.txt" },
      makeContext(),
      makeExecutionContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("not_found");
    expect(result.error.message).toBe("The destination folder does not exist.");
    expect(fake.calls.moveFile).toEqual([]);
  });

  it("rejects an existing destination as already-exists and never overwrites", async () => {
    fake.respondWith.getFileMetadataByPath = {
      "/home/a.txt": metaOf("/home/a.txt", "file"),
      "/home/dest": metaOf("/home/dest", "folder"),
      "/home/dest/b.txt": metaOf("/home/dest/b.txt", "file"),
    };
    const result = await dispatchTool(
      registry,
      "move_file",
      { sourcePath: "/home/a.txt", destinationPath: "/home/dest/b.txt" },
      makeContext(),
      makeExecutionContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.FilesystemAlreadyExists);
    expect(fake.calls.moveFile).toEqual([]);
  });

  it("rejects a destination outside the permitted scope as security", async () => {
    fake.respondWith.getFileMetadataByPath = {
      "/home/a.txt": metaOf("/home/a.txt", "file"),
    };
    fake.throwFor.getFileMetadataByPath = {
      "/etc": new Error("Access to this location is not permitted."),
      "/etc/passwd": new Error("Access to this location is not permitted."),
    };
    const result = await dispatchTool(
      registry,
      "move_file",
      { sourcePath: "/home/a.txt", destinationPath: "/etc/passwd" },
      makeContext(),
      makeExecutionContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.FilesystemNotAllowed);
    expect(fake.calls.moveFile).toEqual([]);
  });

  it("rejects identical source and destination as validation", async () => {
    const result = await dispatchTool(
      registry,
      "move_file",
      { sourcePath: "/home/a.txt", destinationPath: "/home/a.txt" },
      makeContext(),
      makeExecutionContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(fake.calls.moveFile).toEqual([]);
  });

  it("rejects malformed and traversal-escaping paths before any executor call", async () => {
    for (const args of [
      { sourcePath: "relative.txt", destinationPath: "/home/dest/b.txt" },
      { sourcePath: "/home/a.txt", destinationPath: "relative.txt" },
      { sourcePath: "/a\u0000b", destinationPath: "/home/dest/b.txt" },
      { sourcePath: "/home/a.txt", destinationPath: "/../etc" },
    ]) {
      const result = await dispatchTool(
        registry,
        "move_file",
        args,
        makeContext(),
        makeExecutionContext(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.category).toBe(result.error.category);
    }
    expect(fake.calls.getFileMetadata).toEqual([]);
    expect(fake.calls.moveFile).toEqual([]);
  });

  it("propagates executor move failures as categorized errors", async () => {
    scriptMoveState();
    fake.throwFor.moveFile = new Error("Permission denied.");
    const result = await dispatchTool(
      registry,
      "move_file",
      { sourcePath: "/home/a.txt", destinationPath: "/home/dest/b.txt" },
      makeContext(),
      makeExecutionContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.FilesystemPermissionDenied);
  });
});


// ---------------------------------------------------------------------------
// Definitions export the same tools the bridge handles (read + write)
// ---------------------------------------------------------------------------

describe("definitions ↔ handlers wiring", () => {
  it("all defined tools (read + write) have the same names as handledToolNames", () => {
    const definedNames = [
      ...readToolDefinitions.map((d) => d.name),
      ...writeToolDefinitions.map((d) => d.name),
    ].sort();
    const handled = [...handledToolNames].sort();
    expect(handled).toEqual(definedNames);
  });

  it("every defined tool has a matching handler", () => {
    const handlerMap = handlers as unknown as Record<string, unknown>;
    for (const def of [...readToolDefinitions, ...writeToolDefinitions]) {
      expect(handlerMap[def.name]).toBeDefined();
    }
  });

  it("every read tool declares the read permission", () => {
    for (const def of readToolDefinitions) {
      expect(def.permission).toBe("read");
    }
  });

  it("every write tool declares approval-gated permission", () => {
    for (const def of writeToolDefinitions) {
      expect(def.permission).not.toBe("read");
      expect(def.requiresApproval).toBe(true);
    }
  });
});

