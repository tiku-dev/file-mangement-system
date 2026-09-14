/**
 * Unit tests for the Tool Registry (Phase 9.1).
 *
 * The registry is a pure in-memory data structure that describes and organizes
 * tools, but does not execute them. These tests verify the public contract:
 *
 *   - empty registries are valid
 *   - tools can be registered and looked up by exact name
 *   - duplicate registration is rejected deterministically
 *   - unknown lookups fail deterministically
 *   - tool metadata (description, inputSchema, permission) survives round-trip
 *   - behavior does not depend on insertion order
 *
 * No filesystem, no AI provider, no execution handlers.
 */
import { describe, expect, it } from "vitest";

import {
  ToolRegistry,
  ToolRegistryErrorCode,
  isToolRegistryError,
} from "./registry.js";
import type { ToolRegistryError } from "./registry.js";
import type { ToolDefinition, ToolInputSchema } from "./types.js";
import { ToolPermission } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a self-contained tool definition with overridable fields. Keeps
 * tests readable: only the field under test needs to vary.
 */
function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  const inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute filesystem path." },
    },
    required: ["path"],
  };
  return {
    name: "read_file",
    description: "Read the contents of a file.",
    inputSchema,
    permission: ToolPermission.Read,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Empty registry
// ---------------------------------------------------------------------------

describe("ToolRegistry — empty state", () => {
  it("creates an empty registry with size 0", () => {
    const registry = new ToolRegistry();
    expect(registry.size).toBe(0);
  });

  it("returns a deterministic error when looking up a tool in an empty registry", () => {
    const registry = new ToolRegistry();
    expect(() => registry.get("read_file")).toThrowError(
      expect.objectContaining({
        name: "ToolRegistryError",
        code: ToolRegistryErrorCode.UnknownTool,
        toolName: "read_file",
        message: 'No tool named "read_file" is registered.',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Single tool registration & lookup
// ---------------------------------------------------------------------------

describe("ToolRegistry — register and get", () => {
  it("registers a single tool and reports size 1", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    expect(registry.size).toBe(1);
  });

  it("retrieves a registered tool by exact name", () => {
    const registry = new ToolRegistry();
    const tool = makeTool();
    registry.register(tool);
    expect(registry.get("read_file")).toBe(tool);
  });

  it("returns the same reference on repeated lookup (no copying)", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    expect(registry.get("read_file")).toBe(registry.get("read_file"));
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown tool
// ---------------------------------------------------------------------------

describe("ToolRegistry — unknown tool", () => {
  it("throws a structured error with a stable code for unknown names", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    let caught: unknown;
    try {
      registry.get("write_file");
    } catch (error) {
      caught = error;
    }

    expect(isToolRegistryError(caught)).toBe(true);
    expect(caught).toMatchObject({
      name: "ToolRegistryError",
      code: ToolRegistryErrorCode.UnknownTool,
      toolName: "write_file",
    });
    expect((caught as Error).message).toBe(
      'No tool named "write_file" is registered.',
    );
  });

  it("matches tool names exactly (case-sensitive)", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    expect(() => registry.get("Read_File")).toThrowError(
      expect.objectContaining({ code: ToolRegistryErrorCode.UnknownTool }),
    );
    expect(() => registry.get("read_file")).not.toThrow();
  });

  it("matches tool names exactly (no trimming, no normalization)", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    expect(() => registry.get(" read_file")).toThrowError(
      expect.objectContaining({ code: ToolRegistryErrorCode.UnknownTool }),
    );
    expect(() => registry.get("read_file ")).toThrowError(
      expect.objectContaining({ code: ToolRegistryErrorCode.UnknownTool }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Duplicate registration
// ---------------------------------------------------------------------------

describe("ToolRegistry — duplicate registration", () => {
  it("rejects registering a tool with an already-used name", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    let caught: unknown;
    try {
      registry.register(
        makeTool({
          name: "read_file",
          description: "Different description that must not win.",
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(isToolRegistryError(caught)).toBe(true);
    expect(caught).toMatchObject({
      name: "ToolRegistryError",
      code: ToolRegistryErrorCode.DuplicateTool,
      toolName: "read_file",
    });
    expect((caught as Error).message).toBe(
      'A tool named "read_file" is already registered.',
    );
  });

  it("does not replace the original definition when a duplicate is rejected", () => {
    const registry = new ToolRegistry();
    const original = makeTool({
      name: "read_file",
      description: "Original description.",
    });
    registry.register(original);

    expect(() =>
      registry.register(
        makeTool({
          name: "read_file",
          description: "Replacement description.",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: ToolRegistryErrorCode.DuplicateTool }));

    // The original definition is still the one returned.
    const stored = registry.get("read_file");
    expect(stored).toBe(original);
    expect(stored.description).toBe("Original description.");
  });

  it("size does not change when a duplicate registration is rejected", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    expect(registry.size).toBe(1);

    expect(() =>
      registry.register(makeTool({ name: "read_file" })),
    ).toThrow(expect.objectContaining({ code: ToolRegistryErrorCode.DuplicateTool }));
    expect(registry.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Multiple tools
// ---------------------------------------------------------------------------

describe("ToolRegistry — multiple tools", () => {
  it("stores multiple distinct tools and looks each one up by name", () => {
    const registry = new ToolRegistry();
    const read = makeTool({
      name: "read_file",
      description: "Read a file.",
      permission: ToolPermission.Read,
    });
    const write = makeTool({
      name: "write_file",
      description: "Write a file.",
      permission: ToolPermission.Write,
    });
    const trash = makeTool({
      name: "trash_item",
      description: "Move an item to trash.",
      permission: ToolPermission.Destructive,
    });

    registry.register(read);
    registry.register(write);
    registry.register(trash);

    expect(registry.size).toBe(3);
    expect(registry.get("read_file")).toBe(read);
    expect(registry.get("write_file")).toBe(write);
    expect(registry.get("trash_item")).toBe(trash);
  });
});

// ---------------------------------------------------------------------------
// 6. Metadata preservation
// ---------------------------------------------------------------------------

describe("ToolRegistry — metadata preservation", () => {
  it("preserves the description on round-trip", () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool({
        name: "read_file",
        description: "Read the contents of a file at the given path.",
      }),
    );
    expect(registry.get("read_file").description).toBe(
      "Read the contents of a file at the given path.",
    );
  });

  it("preserves the inputSchema on round-trip (deep structural equality)", () => {
    const registry = new ToolRegistry();
    const inputSchema: ToolInputSchema = {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path." },
        encoding: { type: "string", description: "Text encoding." },
        offset: { type: "number", description: "Byte offset." },
        followSymlinks: {
          type: "boolean",
          description: "Whether to follow symlinks.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags.",
        },
      },
      required: ["path"],
    };
    registry.register(makeTool({ name: "read_file", inputSchema }));

    const stored = registry.get("read_file");
    expect(stored.inputSchema).toEqual(inputSchema);
    expect(stored.inputSchema.required).toEqual(["path"]);
    expect(stored.inputSchema.properties?.["path"]).toEqual({
      type: "string",
      description: "Absolute path.",
    });
  });

  it("preserves the permission classification on round-trip", () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool({ name: "read_file", permission: ToolPermission.Read }),
    );
    registry.register(
      makeTool({
        name: "write_file",
        description: "Write a file.",
        permission: ToolPermission.Write,
      }),
    );
    registry.register(
      makeTool({
        name: "trash_item",
        description: "Trash an item.",
        permission: ToolPermission.Destructive,
      }),
    );

    expect(registry.get("read_file").permission).toBe(ToolPermission.Read);
    expect(registry.get("write_file").permission).toBe(ToolPermission.Write);
    expect(registry.get("trash_item").permission).toBe(
      ToolPermission.Destructive,
    );
  });

  it("preserves all metadata fields together", () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: "search_files",
      description: "Recursively search by filename substring.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Search root directory." },
          query: { type: "string", description: "Substring to match." },
        },
        required: ["root", "query"],
      },
      permission: ToolPermission.Read,
    };
    registry.register(tool);
    expect(registry.get("search_files")).toEqual(tool);
  });
});

// ---------------------------------------------------------------------------
// 7. Exact name matching
// ---------------------------------------------------------------------------

describe("ToolRegistry — exact name matching", () => {
  it("treats names with different characters as distinct tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    registry.register(makeTool({ name: "readfile" }));
    registry.register(makeTool({ name: "read_file_v2" }));

    expect(registry.size).toBe(3);
    expect(registry.get("read_file").name).toBe("read_file");
    expect(registry.get("readfile").name).toBe("readfile");
    expect(registry.get("read_file_v2").name).toBe("read_file_v2");
  });

  it("is case-sensitive and does not normalize", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    registry.register(makeTool({ name: "READ_FILE" }));

    expect(registry.size).toBe(2);
    expect(() => registry.get("Read_File")).toThrowError(
      expect.objectContaining({ code: ToolRegistryErrorCode.UnknownTool }),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Determinism
// ---------------------------------------------------------------------------

describe("ToolRegistry — determinism", () => {
  it("does not depend on insertion order for size or independent lookups", () => {
    const tools: ToolDefinition[] = [
      makeTool({ name: "alpha", description: "A" }),
      makeTool({ name: "beta", description: "B" }),
      makeTool({ name: "gamma", description: "C" }),
      makeTool({ name: "delta", description: "D" }),
    ];

    const forward = new ToolRegistry();
    for (const tool of tools) forward.register(tool);

    const reverse = new ToolRegistry();
    for (const tool of [...tools].reverse()) reverse.register(tool);

    // Size is independent of insertion order.
    expect(forward.size).toBe(reverse.size);
    expect(forward.size).toBe(4);

    // Each tool is retrievable by exact name from both registries.
    for (const tool of tools) {
      expect(forward.get(tool.name)).toEqual(tool);
      expect(reverse.get(tool.name)).toEqual(tool);
    }
  });

  it("yields identical error messages across repeated calls", () => {
    const registry = new ToolRegistry();

    const first = captureThrow(() => registry.get("missing"));
    const second = captureThrow(() => registry.get("missing"));
    const third = captureThrow(() => registry.get("missing"));

    expect(first.message).toBe(second.message);
    expect(second.message).toBe(third.message);
    expect(first.code).toBe(second.code);
    expect(second.code).toBe(third.code);
  });

  it("yields identical duplicate-error messages across calls", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    const first = captureThrow(() =>
      registry.register(makeTool({ name: "read_file" })),
    );
    const second = captureThrow(() =>
      registry.register(makeTool({ name: "read_file" })),
    );

    expect(first.message).toBe(second.message);
    expect(first.code).toBe(second.code);
  });
});

// ---------------------------------------------------------------------------
// 9. Error-shape contract
// ---------------------------------------------------------------------------

describe("ToolRegistry — error contract", () => {
  it("uses distinct, stable codes for duplicate vs. unknown", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    const dup = captureThrow(() =>
      registry.register(makeTool({ name: "read_file" })),
    );
    const unknown = captureThrow(() => registry.get("nope"));

    expect(dup.code).toBe(ToolRegistryErrorCode.DuplicateTool);
    expect(unknown.code).toBe(ToolRegistryErrorCode.UnknownTool);
    expect(dup.code).not.toBe(unknown.code);
  });

  it("attaches the offending tool name to the error", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    const dup = captureThrow(() =>
      registry.register(makeTool({ name: "read_file" })),
    );
    const unknown = captureThrow(() => registry.get("missing_tool"));

    expect(dup.toolName).toBe("read_file");
    expect(unknown.toolName).toBe("missing_tool");
  });

  it("identifies thrown errors via the type guard", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));

    try {
      registry.get("nope");
    } catch (error) {
      expect(isToolRegistryError(error)).toBe(true);
    }

    try {
      registry.register(makeTool({ name: "read_file" }));
    } catch (error) {
      expect(isToolRegistryError(error)).toBe(true);
    }

    // Non-registry errors must not be claimed by the type guard.
    expect(isToolRegistryError(new Error("not a registry error"))).toBe(false);
    expect(isToolRegistryError(null)).toBe(false);
    expect(isToolRegistryError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Isolation between registries
// ---------------------------------------------------------------------------

describe("ToolRegistry — isolation", () => {
  it("two registries do not share state", () => {
    const a = new ToolRegistry();
    const b = new ToolRegistry();

    a.register(makeTool({ name: "read_file" }));

    expect(a.size).toBe(1);
    expect(b.size).toBe(0);
    expect(() => b.get("read_file")).toThrowError(
      expect.objectContaining({ code: ToolRegistryErrorCode.UnknownTool }),
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Availability check (has) — used by agent context tool filtering
// ---------------------------------------------------------------------------

describe("ToolRegistry — has (availability)", () => {
  it("is false for an absent name and never throws", () => {
    const registry = new ToolRegistry();
    expect(registry.has("read_file")).toBe(false);
  });

  it("is true for a registered name and false for an unknown one", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    expect(registry.has("read_file")).toBe(true);
    expect(registry.has("write_file")).toBe(false);
  });

  it("matches names exactly (case-sensitive) like get()", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    expect(registry.has("Read_File")).toBe(false);
    expect(registry.has(" read_file")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureThrow(throwingFn: () => unknown): ToolRegistryError {
  try {
    throwingFn();
  } catch (error) {
    if (!isToolRegistryError(error)) {
      throw new Error(
        `Expected a ToolRegistryError but caught: ${String(error)}`,
      );
    }
    return error;
  }
  throw new Error("Expected the supplied function to throw.");
}
