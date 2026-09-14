/**
 * Tool Registry (Phase 9.1).
 *
 * In-memory storage and lookup of tool definitions. Independent of any AI
 * provider or execution handler. Registration rejects duplicate names and
 * lookup of unknown names returns a deterministic structured error.
 *
 * A plain `Map` guarantees lookup/registration are independent of object or
 * property iteration order, keeping behavior deterministic.
 */
import type { ToolDefinition } from "./types.js";

/** Stable, machine-readable reason codes for registry errors. */
export const ToolRegistryErrorCode = {
  DuplicateTool: "tools/duplicate-tool",
  UnknownTool: "tools/unknown-tool",
} as const;

export type ToolRegistryErrorCode =
  (typeof ToolRegistryErrorCode)[keyof typeof ToolRegistryErrorCode];

export interface ToolRegistryError extends Error {
  readonly code: ToolRegistryErrorCode;
  readonly toolName: string;
}

const DUPLICATE_MESSAGE = (name: string) =>
  `A tool named "${name}" is already registered.`;
const UNKNOWN_MESSAGE = (name: string) =>
  `No tool named "${name}" is registered.`;

function createError(code: ToolRegistryErrorCode, toolName: string, message: string): ToolRegistryError {
  const error = new Error(message) as ToolRegistryError;
  error.name = "ToolRegistryError";
  // The interface declares `code` and `toolName` as readonly for callers
  // consuming the error, but the constructor itself must assign them.
  (error as { code: ToolRegistryErrorCode }).code = code;
  (error as { toolName: string }).toolName = toolName;
  return error;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Readonly<ToolDefinition>>();

  /** Register a tool. Rejects any name already present. */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw createError(
        ToolRegistryErrorCode.DuplicateTool,
        tool.name,
        DUPLICATE_MESSAGE(tool.name),
      );
    }
    this.tools.set(tool.name, tool);
  }

  /** Look up a tool by exact name. */
  get(name: string): Readonly<ToolDefinition> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw createError(
        ToolRegistryErrorCode.UnknownTool,
        name,
        UNKNOWN_MESSAGE(name),
      );
    }
    return tool;
  }

  /**
   * Whether a tool with the given name is registered (available). Unlike
   * `get`, this never throws — it is for filtering/availability checks.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}

export function isToolRegistryError(error: unknown): error is ToolRegistryError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code !== undefined
  );
}
