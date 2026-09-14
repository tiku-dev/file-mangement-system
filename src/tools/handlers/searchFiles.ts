/**
 * `search_files` tool handler (Phase 9.3 + 9.4).
 *
 * Purpose: Recursively search filenames by substring (case-insensitive).
 * Input:   { query: string }
 * Output:  FileEntry[] (Tauri shape)
 *
 * The handler validates its UNTRUSTED input, then delegates entirely
 * to the injected `FilesystemExecutor`. The Rust `AllowList` gates the
 * walk; the handler does not duplicate any search logic.
 *
 * Phase 9.4: executor errors are mapped to categorized `ToolError`s.
 *
 * Phase 10.37: `search_files` takes NO path argument — its `query` is a
 * filename substring and the Rust walk is confined to the AllowList's
 * roots, so there is no user-controlled path for the `validateToolPath`
 * scope guard to check (and the query must never be treated as one). The
 * one malformed-input class that applies here is a query containing NUL /
 * control characters, which is rejected via the SHARED path-guard helper
 * (`hasControlCharacters`) before the executor is reached.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import { mapExecutorError } from "./executorErrors.js";
import { hasControlCharacters } from "../paths.js";
import { ToolError, ToolErrorCode } from "../errors.js";
import type { FileEntry } from "../tauriShapes.js";

export const searchFilesHandler: ToolHandlerFunction<FileEntry[]> = async (
  input,
  ctx,
) => {
  const queryResult = requireString(input, "query");
  if (!queryResult.ok) throw queryResult.error;
  if (hasControlCharacters(queryResult.value)) {
    throw ToolError.validation(
      ToolErrorCode.InvalidInput,
      "The query contains an invalid character.",
    );
  }
  try {
    return await ctx.filesystem.searchFiles(queryResult.value);
  } catch (error) {
    throw mapExecutorError(error, "Unable to search files.");
  }
};

