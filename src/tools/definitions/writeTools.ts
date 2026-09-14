/**
 * Write tool definitions (Phase 10.36).
 *
 * Each definition is a pure metadata object: name, description, inputSchema,
 * permission, and — critically for Phase 10.36 — `requiresApproval`. Write
 * tools mutate the filesystem, so they are approval-gated at the definition,
 * not by any handler. No execution logic lives here.
 *
 * These definitions are wired into a `ToolRegistry` by `registerWriteTools`.
 */
import { ToolPermission, type ToolDefinition } from "../types.js";

const moveFileDefinition: ToolDefinition = {
  name: "move_file",
  description:
    "Move a file to an exact destination path. The destination may keep the file's original name (a plain move) or introduce a new name (a move that also renames). Both paths must be absolute and within the permitted scope. The source must be an existing file — folders are not moved, and files cannot be overwritten. The destination folder must already exist. This operation changes the filesystem and therefore requires explicit user approval before it executes.",
  inputSchema: {
    type: "object",
    properties: {
      sourcePath: {
        type: "string",
        description:
          "Absolute path of the existing file to move. Must be within an allowed scope.",
      },
      destinationPath: {
        type: "string",
        description:
          "Absolute full path the file should have after the move (including the file name). Must be within an allowed scope; its parent folder must already exist.",
      },
    },
    required: ["sourcePath", "destinationPath"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const writeToolDefinitions: readonly ToolDefinition[] = Object.freeze([
  moveFileDefinition,
]);

/**
 * Register all write tools into the given registry. Throws
 * `ToolRegistryError` if a tool is already registered.
 */
export function registerWriteTools(
  registry: { register: (tool: ToolDefinition) => void },
): void {
  for (const tool of writeToolDefinitions) {
    registry.register(tool);
  }
}