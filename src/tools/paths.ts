/**
 * Tool path validation — permitted filesystem scope (Phase 10.35).
 *
 * The AI must never coerce a tool into touching a path outside the app's
 * allowed scope. Scope membership is FINAL authority of the desktop's Rust
 * `AllowList` (canonical-path containment against the home directory), but
 * this module is the tool layer's deterministic first gate: it stops clearly
 * invalid or traversal-escaped paths BEFORE any executor call.
 *
 * Rules enforced here (all shape-only, never I/O):
 *
 *   - the path must be ABSOLUTE (POSIX `/`, a Windows drive `X:\`, or a UNC
 *     server share). A relative path is ambiguous and unusable by the
 *     canonical-scope executor — it is rejected as invalid input;
 *   - the path must not contain NUL or control characters;
 *   - the path must not ESCAPE the root: any `..` segment that would climb
 *     above the root is rejected as out of scope (category `security`).
 *     Paths like `/a/../b` that stay within the root are accepted.
 *
 * The guard returns the ORIGINAL string unchanged on success — the executor /
 * Rust layer still canonicalizes and re-verifies actual scope membership.
 * Nothing here reads, writes, normalizes-on-disk, or resolves symlinks.
 *
 * Messages never include the raw path: raw OS paths must not leak into
 * public error text.
 */
import { ToolError, ToolErrorCode } from "./errors.js";

/** True for an absolute path on POSIX, Windows drive letters, or UNC. */
export function isAbsoluteToolPath(path: string): boolean {
  if (path.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  if (path.startsWith("\\\\")) return true;
  return false;
}

function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * True when the string contains NUL or control characters (ASCII < 0x20).
 * Shared by `validateToolPath` (path guard) and the query-valued read tools
 * that have no path argument but must still reject malformed control bytes
 * before the executor is reached.
 */
export function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/** True when a `..` segment anywhere in the path climbs ABOVE the root. */
export function escapesToolScope(path: string): boolean {
  const parts = isWindowsAbsolute(path) ? path.split(/[\\/]+/) : path.split("/");

  // Index of the first segment AFTER the path's root marker(s):
  //   - POSIX `/a/b`      → ["", "a", "b"]                  → start 1 (skip "" root)
  //   - drive `C:\a\b`    → ["C:", "a", "b"]                → start 1 (skip "C:")
  //   - UNC `\\s\sh\a`    → ["", "", "s", "sh", "a"]        → start 4 (skip "", "", server, share)
  const start = isWindowsAbsolute(path)
    ? path.startsWith("\\\\")
      ? 4
      : 1
    : 1;

  let depth = 0;
  for (let i = start; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined || part === "" || part === ".") continue;
    if (part === "..") {
      if (depth === 0) return true;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return false;
}

export type PathValidation =
  | { ok: true; path: string }
  | { ok: false; error: ToolError };

/**
 * Return the parent directory of an absolute path (both POSIX `/` and Windows
 * `\` separators), or `null` when the path has no parent (it is already a
 * filesystem root). Trailing separators are ignored, so `"/a/b/"` and
 * `"/a/b"` both yield `"/a"`. The root itself (`"/"`, `"C:\"`, `"C:/"`,
 * `"\\server\share"`) has no parent.
 *
 * Shape-only, never I/O. Used by validation that must reason about a
 * destination path's containing folder before any executor call.
 */
export function parentDirectory(path: string): string | null {
  const parts = path.split(/[\\/]+/);
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();

  if (!isWindowsAbsolute(path)) {
    // POSIX root has no parent; everything else names its parent by the
    // segment list minus the final component.
    if (parts.length <= 1) return null;
    parts.pop();
    // After the pop, the first element is always "" (the leading-slash
    // artefact of split("/")).  Joining already produces the leading "/"
    // (e.g. ["", "a", "b"].join("/") === "/a/b"), so we must NOT prepend
    // another "/" — that would yield a double-slash like "//a/b".
    const joined = parts.join("/");
    return joined === "" ? "/" : joined;
  }
  if (parts.length <= 1) {
    // A bare `C:` was already rejected by isAbsoluteToolPath; treat a
    // root-only drive or UNC share as having no parent.
    return null;
  }
  parts.pop();
  const lastRemaining = parts[0];
  if (parts.length === 1 && lastRemaining !== undefined && /^[A-Za-z]:$/.test(lastRemaining)) {
    return lastRemaining + "\\";
  }
  if (path.startsWith("\\\\") && parts.length <= 3) return null;
  return parts.join("\\");
}

/**
 * Deterministic first gate for a tool-provided directory/file path. Rejects
 * relative, control-character, and root-escaping paths as typed `ToolError`s
 * — `validation` / `tools/invalid-path` for unusable input, `security` /
 * `tools/path-out-of-scope` for traversal. On success the original string is
 * passed through unmodified for the canonical scope check to re-verify.
 */
export function validateToolPath(path: string): PathValidation {
  if (!isAbsoluteToolPath(path)) {
    return {
      ok: false,
      error: ToolError.validation(
        ToolErrorCode.InvalidPath,
        "The path must be absolute.",
      ),
    };
  }
  if (hasControlCharacters(path)) {
    return {
      ok: false,
      error: ToolError.validation(
        ToolErrorCode.InvalidPath,
        "The path contains an invalid character.",
      ),
    };
  }
  if (escapesToolScope(path)) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.PathOutOfScope,
        "The path escapes the permitted filesystem scope.",
      ),
    };
  }
  return { ok: true, path };
}