/**
 * `read_file` tool handler (Phase 9.3 + 9.4).
 *
 * Purpose: Read the raw bytes of a file.
 * Input:   { path: string }
 * Output:  { encoding: "base64"; data: string }
 *
 * The handler validates its UNTRUSTED input, then delegates entirely
 * to the injected `FilesystemExecutor`. The Rust `AllowList` authorizes
 * the path; this handler adds nothing to the security boundary.
 *
 * Phase 9.4: executor errors are mapped to categorized `ToolError`s.
 *
 * Phase 10.37: before the executor is reached, the path is passed through
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

interface ReadFileOutput {
  encoding: "base64";
  data: string;
}

export const readFileHandler: ToolHandlerFunction<ReadFileOutput> = async (
  input,
  ctx,
) => {
  const pathResult = requireString(input, "path");
  if (!pathResult.ok) throw pathResult.error;
  const guardResult = validateToolPath(pathResult.value);
  if (!guardResult.ok) throw guardResult.error;
  try {
    return await ctx.filesystem.readFile(guardResult.path);
  } catch (error) {
    throw mapExecutorError(error, "Unable to read the file.");
  }
};

