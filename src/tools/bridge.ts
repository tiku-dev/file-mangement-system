/**
 * Public entrypoint for the Tool Execution Bridge (Phase 9.3).
 *
 * Exports the FilesystemExecutor seam, the four read-only tool
 * definitions, the handler contract, the dispatch function, and the
 * Tauri-shaped DTOs. Centralizing the public API here keeps the rest
 * of the backend from reaching into individual modules.
 *
 * This module is the SINGLE import a future AI agent, HTTP route, or
 * in-process caller should need. It composes:
 *
 *   - Phase 9.1: ToolRegistry (provider-agnostic storage)
 *   - Phase 9.2: Read-only ToolDefinitions (metadata only)
 *   - Phase 9.3: FilesystemExecutor + Handlers + Dispatch (this phase)
 *
 * The bridge does NOT introduce a new transport; it reuses the Tauri
 * IPC channel the web app already uses through DesktopFilesystemProvider.
 */
export { ToolRegistry, isToolRegistryError, ToolRegistryErrorCode } from "./registry.js";
export type { ToolRegistryError } from "./registry.js";

export { ToolPermission } from "./types.js";
export type {
  ToolDefinition,
  ToolInputSchema,
  ToolInputSchemaProperty,
} from "./types.js";

export { readToolDefinitions, registerReadTools } from "./definitions/readTools.js";
export { writeToolDefinitions, registerWriteTools } from "./definitions/writeTools.js";

export type { FilesystemExecutor, TauriInvoke } from "./executor.js";
export { tauriFilesystemExecutor } from "./executor.js";

export {
  handlers,
  handledToolNames,
  dispatchTool,
  runToolPreflight,
} from "./handlers/index.js";
export type {
  RawToolInput,
  ToolExecutionResult,
  ToolFailureResult,
  ToolHandler,
  ToolHandlerContext,
  ToolHandlerFunction,
  ToolSuccessResult,
} from "./handlers/handler.js";

export {
  ToolError,
  ToolErrorCode,
  isToolError,
  toToolError,
} from "./errors.js";
export type { ToolErrorCategory, ToolErrorCode as ToolErrorCodeType } from "./errors.js";

export {
  defaultToolPolicy,
  enforcePolicy,
} from "./policy.js";
export type {
  ToolActor,
  ToolExecutionContext,
  ToolPolicy,
  PolicyDecision,
} from "./policy.js";

export type {
  DirectoryListing,
  FileEntry,
  FileMetadata,
} from "./tauriShapes.js";

