/**
 * Read-only filesystem tool definitions (Phase 9.2).
 *
 * Each definition is a pure metadata object: name, description, inputSchema,
 * and permission. No execution logic lives here.
 *
 * These definitions are wired into a `ToolRegistry` by `registerReadTools`.
 */
import { ToolPermission, type ToolDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Individual definitions
// ---------------------------------------------------------------------------

const listDirectoryDefinition: ToolDefinition = {
  name: "list_directory",
  description:
    "List the immediate contents of a directory. Returns entries for every file and subdirectory, with metadata such as size, modification date, and item count. The caller should supply an absolute path (e.g. the home directory) to start from.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path of the directory to list. Must be within an allowed scope.",
      },
    },
    required: ["path"],
  },
  permission: ToolPermission.Read,
};

const searchFilesDefinition: ToolDefinition = {
  name: "search_files",
  description:
    "Recursively search for files whose name contains the given substring (case-insensitive). The search walks all allowed directories from their roots. Returns the canonical path, name, file type, size, and modification date for each match.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Substring to search for in filenames (case-insensitive). Empty queries return no results.",
      },
    },
    required: ["query"],
  },
  permission: ToolPermission.Read,
};

const getFileMetadataDefinition: ToolDefinition = {
  name: "get_file_metadata",
  description:
    "Retrieve metadata for a single file or directory — name, canonical path, size, type, timestamps, and whether the item is hidden — WITHOUT reading its contents. Use this to inspect an item before deciding whether to read it.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path of the file or directory whose metadata to retrieve.",
      },
    },
    required: ["path"],
  },
  permission: ToolPermission.Read,
};

const readFileDefinition: ToolDefinition = {
  name: "read_file",
  description:
    "Read the raw bytes of a file and return them as a base64-encoded string. The caller must decode the base64 to recover the original content. Files larger than 64 MiB are rejected. Use `get_file_metadata` first to inspect the file before reading it.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path of the file to read. Must be within an allowed scope.",
      },
    },
    required: ["path"],
  },
  permission: ToolPermission.Read,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const readToolDefinitions: readonly ToolDefinition[] = Object.freeze([
  listDirectoryDefinition,
  searchFilesDefinition,
  getFileMetadataDefinition,
  readFileDefinition,
]);

/**
 * Register all four read-only filesystem tools into the given registry.
 * Throws `ToolRegistryError` if a tool is already registered.
 */
export function registerReadTools(
  registry: { register: (tool: ToolDefinition) => void },
): void {
  for (const tool of readToolDefinitions) {
    registry.register(tool);
  }
}

