/**
 * Tool Execution Contract — error model (Phase 9.4).
 *
 * Every tool execution returns a structured `ToolExecutionResult<T>`. On
 * failure, the result's `error` field is a `ToolError` with an explicit
 * `category` so the rest of the system can branch without parsing the
 * `code` string or the `message` text.
 *
 * Categories are intentionally narrow. The full set is:
 *
 *   - "validation"    The input was malformed (missing required field,
 *                      wrong type, empty string, etc.).
 *   - "unknown_tool"  The caller asked for a tool that is not registered.
 *   - "not_found"     The target (path, query, etc.) does not exist.
 *   - "security"      The AllowList denied the operation, or the OS
 *                      permission model denied the operation.
 *   - "internal"      An unexpected error, a wiring bug, or a transport
 *                      failure. Public messages MUST NOT leak internals.
 *
 * The contract is independent of any particular transport (HTTP, IPC,
 * queue). A future HTTP route projects each category to a status code
 * at the API boundary, not inside the tool layer. The `status` field
 * here is a SUGGESTED mapping carried alongside the category so callers
 * that don't care about categories (e.g. test scaffolding) can still
 * read a familiar number.
 *
 * `code` is a stable "<area>/<reason>" identifier. The set of valid codes
 * is enumerated in `ToolErrorCode` so callers and tests can pin them.
 */
import { AppError } from "../core/errors.js";

/** The exhaustive set of tool error categories. */
export type ToolErrorCategory =
  | "validation"
  | "unknown_tool"
  | "not_found"
  | "security"
  | "internal";

/**
 * Stable, machine-readable reason codes for tool errors. The HTTP layer
 * can reuse these strings as the public `error.code`; the tool layer
 * uses them for in-process branching.
 */
export const ToolErrorCode = {
  // validation
  InvalidInput: "tools/invalid-input",
  HandlerMissing: "tools/handler-missing",
  // validation — path guard (Phase 10.35)
  InvalidPath: "tools/invalid-path",
  // security — path guard (Phase 10.35)
  PathOutOfScope: "tools/path-out-of-scope",
  // unknown_tool
  UnknownTool: "tools/unknown-tool",
  // not_found
  FilesystemNotFound: "filesystem/not-found",
  // validation — filesystem write operations (Phase 10.36)
  FilesystemNotAFile: "filesystem/not-a-file",
  FilesystemNotADirectory: "filesystem/not-a-directory",
  FilesystemAlreadyExists: "filesystem/already-exists",
  // security
  PermissionDenied: "tools/permission-denied",
  PolicyContextMissing: "tools/policy-context-missing",
  IdentityMissing: "tools/identity-missing",
  IdentityInvalid: "tools/identity-invalid",
  FilesystemPermissionDenied: "filesystem/permission-denied",
  FilesystemNotAllowed: "filesystem/not-allowed",
  // security — approval gate (Phase 10.28C)
  ApprovalRequired: "tools/approval-required",
  ApprovalNotFound: "tools/approval-not-found",
  ApprovalNotExecutable: "tools/approval-not-executable",
  ApprovalToolMismatch: "tools/approval-tool-mismatch",
  ApprovalContextMissing: "tools/approval-context-missing",
  // validation — approval gate (Phase 10.28C)
  ApprovalInvalidArguments: "tools/approval-invalid-arguments",
  // internal
  Internal: "internal/error",
} as const;
export type ToolErrorCode =
  (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

/**
 * The default HTTP status suggested for each category. Tool consumers
 * that don't care about the category can read this directly; consumers
 * that do care should branch on `category` first.
 */
const SUGGESTED_STATUS: Record<ToolErrorCategory, number> = {
  validation: 400,
  unknown_tool: 400,
  not_found: 404,
  security: 403,
  internal: 500,
};


/**
 * A structured tool error. The shape is intentionally transport-agnostic:
 * it has no dependency on Hono, HTTP, or the executor. A future HTTP
 * route will project this into a `Response`; a future AI agent will
 * read it directly.
 */
export class ToolError extends Error {
  readonly category: ToolErrorCategory;
  readonly code: string;
  readonly status: number;

  constructor(
    category: ToolErrorCategory,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
    this.category = category;
    this.code = code;
    this.status = SUGGESTED_STATUS[category];
  }

  /** Convenience for building a `validation` error. */
  static validation(code: string, message: string): ToolError {
    return new ToolError("validation", code, message);
  }

  /** Convenience for an `unknown_tool` error. */
  static unknownTool(name: string): ToolError {
    return new ToolError(
      "unknown_tool",
      ToolErrorCode.UnknownTool,
      `No tool named "${name}" is registered.`,
    );
  }

  /** Convenience for a `not_found` error. */
  static notFound(code: string, message: string): ToolError {
    return new ToolError("not_found", code, message);
  }

  /** Convenience for a `security` error. */
  static security(code: string, message: string): ToolError {
    return new ToolError("security", code, message);
  }

  /** Convenience for an `internal` error. Public-safe message required. */
  static internal(message = "Tool execution failed."): ToolError {
    return new ToolError("internal", ToolErrorCode.Internal, message);
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

/**
 * Project any thrown value into a `ToolError`. Used by `runHandler` to
 * convert unexpected throws into the public envelope.
 *
 * The `defaultCategory` is the category assigned when the thrown value
 * does not already carry one. Handlers are expected to throw a
 * `ToolError` directly with the correct category; this function is the
 * safety net for things like executor failures (which arrive as plain
 * `Error`s) and unknown code paths.
 */
export function toToolError(
  error: unknown,
  defaultCategory: ToolErrorCategory = "internal",
): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof AppError) {
    // AppError was the Phase 9.3 envelope. Map its status back to a
    // category. This is the ONLY translation path between the two
    // envelopes; it lives here so individual handlers do not have to
    // know about it.
    const category = categoryFromStatus(error.status);
    return new ToolError(category, error.code, error.message);
  }
  if (error instanceof Error) {
    // Public-safe message; do not leak the raw error text.
    return new ToolError(
      defaultCategory,
      ToolErrorCode.Internal,
      "Tool execution failed.",
    );
  }
  return new ToolError(
    defaultCategory,
    ToolErrorCode.Internal,
    "Tool execution failed.",
  );
}

/**
 * Map an HTTP status (carried by an `AppError`) back to a tool category.
 * Used by the AppError → ToolError bridge. The mapping mirrors the
 * SUGGESTED_STATUS table but goes the other direction.
 */
function categoryFromStatus(status: number): ToolErrorCategory {
  if (status === 400) return "validation";
  if (status === 403) return "security";
  if (status === 404) return "not_found";
  if (status === 409) return "validation";
  return "internal";
}

