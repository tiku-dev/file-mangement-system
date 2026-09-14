/**
 * `move_file` tool handler (Phase 10.36).
 *
 * Purpose: Move a file to an exact destination path (optionally renaming
 *          it). Write operation — always approval-gated.
 * Input:   { sourcePath: string, destinationPath: string }
 * Output:  { movedFrom: string, movedTo: string }
 *
 * The SAME validation function is used twice:
 *   1. in the approval gate's per-tool PREFLIGHT, before an approval
 *      record is even created, and
 *   2. at EXECUTION time, before the executor runs, so arguments that were
 *      validated days ago are re-validated against the current filesystem.
 *
 * `validateMoveFileInput` is read-only: it inspects metadata only and never
 * mutates the filesystem, so re-running it is always safe. It rejects
 * malformed input, non-absolute or scope-escaping paths, missing or
 * folder sources, missing destination folders, and existing destinations —
 * the last three can change between approval and execution, which is why
 * execution re-runs it.
 *
 * Phase 10.36 spec: no shell, no OS commands, no copy/delete/rename — the
 * only mutation is `FilesystemExecutor.moveFile`, which delegates to the
 * Rust `move_file` command (AllowList-authoritative).
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
  type RawToolInput,
} from "./handler.js";
import { mapExecutorError } from "./executorErrors.js";
import { parentDirectory, validateToolPath } from "../paths.js";
import { ToolError, ToolErrorCode } from "../errors.js";
import type { FilesystemExecutor } from "../executor.js";

export interface MoveFileArguments {
  sourcePath: string;
  destinationPath: string;
}

export interface MoveFileResult {
  movedFrom: string;
  movedTo: string;
}

/**
 * Deep, read-only validation shared by the approval preflight and the
 * execution path. Throws a categorized `ToolError` on any problem:
 *
 *   - malformed input                         → validation / tools/invalid-input
 *   - relative / control-char / escaping path → validation|security / tools/*
 *   - source missing                          → not_found / filesystem/not-found
 *   - source is a folder                      → validation / filesystem/not-a-file
 *   - destination parent missing              → not_found / filesystem/not-found
 *   - destination parent not a folder         → validation / filesystem/not-a-directory
 *   - destination already exists              → validation / filesystem/already-exists
 *   - any step outside permitted scope        → security / filesystem/not-allowed
 *
 * Returns the validated absolute path pair on success.
 */
export async function validateMoveFileInput(
  input: RawToolInput,
  filesystem: FilesystemExecutor,
): Promise<MoveFileArguments> {
  const sourceResult = requireString(input, "sourcePath");
  if (!sourceResult.ok) throw sourceResult.error;
  const destinationResult = requireString(input, "destinationPath");
  if (!destinationResult.ok) throw destinationResult.error;

  const { sourcePath, destinationPath } = {
    sourcePath: sourceResult.value,
    destinationPath: destinationResult.value,
  };

  const sourceCheck = validateToolPath(sourcePath);
  if (!sourceCheck.ok) throw sourceCheck.error;
  const destinationCheck = validateToolPath(destinationPath);
  if (!destinationCheck.ok) throw destinationCheck.error;

  if (sourcePath === destinationPath) {
    throw ToolError.validation(
      ToolErrorCode.InvalidInput,
      "The destination path must differ from the source path.",
    );
  }

  // 1. The source must exist and be a file.
  const sourceMetadata = await filesystem
    .getFileMetadata(sourcePath)
    .catch((error: unknown) => {
      throw mapExecutorError(error, "The file or folder no longer exists.");
    });
  if (!sourceMetadata.isFile) {
    throw ToolError.validation(
      ToolErrorCode.FilesystemNotAFile,
      "The source is not a file.",
    );
  }

  // 2. The destination's parent folder must exist and be a folder.
  const parent = parentDirectory(destinationPath);
  if (parent === null) {
    throw ToolError.validation(
      ToolErrorCode.InvalidPath,
      "The destination path is invalid.",
    );
  }
  const parentMetadata = await filesystem.getFileMetadata(parent).catch(
    (error: unknown) => {
      const mapped = mapExecutorError(
        error,
        "The destination folder does not exist.",
      );
      if (mapped.category === "not_found") {
        throw ToolError.notFound(
          ToolErrorCode.FilesystemNotFound,
          "The destination folder does not exist.",
        );
      }
      throw mapped;
    },
  );
  if (!parentMetadata.isFolder) {
    throw ToolError.validation(
      ToolErrorCode.FilesystemNotADirectory,
      "The destination is not a folder.",
    );
  }

  // 3. The destination itself must NOT already exist — a move never
  //    overwrites. A not-found destination is exactly what we want.
  let destinationMetadata: Awaited<
    ReturnType<FilesystemExecutor["getFileMetadata"]>
  > | null = null;
  try {
    destinationMetadata = await filesystem.getFileMetadata(destinationPath);
  } catch (error) {
    const mapped = mapExecutorError(error, "Tool execution failed.");
    if (mapped.category !== "not_found") throw mapped;
  }
  if (destinationMetadata !== null) {
    throw ToolError.validation(
      ToolErrorCode.FilesystemAlreadyExists,
      "A file or folder with that name already exists.",
    );
  }

  return { sourcePath, destinationPath };
}

/**
 * Execute the move after the caller's own validation succeeded. The full
 * re-validation happens inside `validateMoveFileInput` at execution time;
 * this wrapper performs only the actual (authorized) mutation and shapes the
 * executor errors that can still race into the window between validation
 * and rename (permission revoked, destination appeared, source vanished).
 */
export const moveFileHandler: ToolHandlerFunction<MoveFileResult> = async (
  input,
  ctx,
) => {
  const paths = await validateMoveFileInput(input, ctx.filesystem);
  try {
    await ctx.filesystem.moveFile(paths.sourcePath, paths.destinationPath);
  } catch (error) {
    throw mapExecutorError(error, "Unable to move the file.");
  }
  return { movedFrom: paths.sourcePath, movedTo: paths.destinationPath };
};

export type { ToolHandlerContext };