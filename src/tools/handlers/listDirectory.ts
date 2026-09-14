/**
 * `list_directory` tool handler (Phase 9.3 + 9.4).
 *
 * Purpose: List the contents of a directory.
 * Input:   { path: string }
 * Output:  DirectoryListing (Tauri shape, identical to the web app's)
 *
 * The handler validates its UNTRUSTED input, then delegates entirely
 * to the injected `FilesystemExecutor`, which is the bridge to the
 * desktop's Tauri command and, behind that, the Rust `fs_service`. The
 * Rust `AllowList` authorizes the operation; this handler adds nothing
 * to the security boundary.
 *
 * Phase 9.4: executor errors are mapped to categorized `ToolError`s
 * via the shared `mapExecutorError` helper, so the dispatch surface
 * sees a clean `category` for every failure mode.
 *
 * Phase 10.35: before the executor is reached, the path is passed through
 * the deterministic tool-layer scope guard (`validateToolPath`). Relative,
 * control-character, and root-escaping (`..`) paths are rejected as typed
 * `ToolError`s — the executor is never called with an unusable or
 * out-of-scope path. Scope membership remains the Rust `AllowList`'s final
 * authority; this guard is the first gate, not a second filesystem layer.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import { mapExecutorError } from "./executorErrors.js";
import { validateToolPath } from "../paths.js";
import type { DirectoryListing } from "../tauriShapes.js";

export const listDirectoryHandler: ToolHandlerFunction<DirectoryListing> =
  async (input, ctx) => {
    const pathResult = requireString(input, "path");
    if (!pathResult.ok) throw pathResult.error;
    const guardResult = validateToolPath(pathResult.value);
    if (!guardResult.ok) throw guardResult.error;
    try {
      return await ctx.filesystem.listDirectory(guardResult.path);
    } catch (error) {
      throw mapExecutorError(error, "Unable to list the directory.");
    }
  };

