/**
 * Tool handler contract (Phase 9.3 + Phase 9.4).
 *
 * The contract intentionally has no knowledge of:
 *   - any particular AI provider,
 *   - any particular LLM, prompt, or message,
 *   - any HTTP or IPC transport.
 *
 * A handler:
 *   1. Receives an UNTRUSTED input object (keys/values/types all
 *      unverified — the AI may pass anything).
 *   2. Validates the input against the tool's `inputSchema` (shape
 *      only — the registry does not own validation; handlers do).
 *   3. Calls the FilesystemExecutor (the bridge to the desktop).
 *   4. Returns a structured result or throws a structured error.
 *
 * Handlers never access the filesystem directly. They go through the
 * `FilesystemExecutor`, which delegates to Tauri → Rust → AllowList.
 *
 * Phase 9.4 standardizes the success / failure contract. Every handler
 * returns `ToolExecutionResult<T>`. The failure variant is a `ToolError`
 * with an explicit `category` so callers can branch without parsing
 * the code or message.
 */
import type { FilesystemExecutor } from "../executor.js";
import { ToolError, type ToolErrorCategory, toToolError } from "../errors.js";
import type { ToolDefinition } from "../types.js";

/**
 * The untrusted input bag from a tool invocation. A handler must never
 * trust a key or value type until it has validated it.
 */
export type RawToolInput = Record<string, unknown>;

/**
 * Per-invocation context handed to handlers. Carries the
 * already-constructed dependencies so handlers stay pure / easy to test.
 */
export interface ToolHandlerContext {
  filesystem: FilesystemExecutor;
}

/** A successful tool execution. */
export interface ToolSuccessResult<T = unknown> {
  ok: true;
  data: T;
}

/** A failed tool execution. The error is a public `ToolError`. */
export interface ToolFailureResult {
  ok: false;
  error: ToolError;
}

export type ToolExecutionResult<T = unknown> =
  | ToolSuccessResult<T>
  | ToolFailureResult;

/**
 * The core function a handler runs. Throws on failure; the wrapper
 * `runHandler` converts thrown errors into structured `ToolExecutionResult`s.
 * Pure: same input ⇒ same output (modulo executor state).
 */
export type ToolHandlerFunction<T = unknown> = (
  input: RawToolInput,
  context: ToolHandlerContext,
) => Promise<T> | T;

/**
 * A registered handler — the wrapper that produces a structured result.
 * This is what gets stored in the handler map.
 */
export type ToolHandler<T = unknown> = (
  input: RawToolInput,
  context: ToolHandlerContext,
) => Promise<ToolExecutionResult<T>>;

/**
 * Run a handler function and return a structured result.
 *
 * The `defaultCategory` is the category assigned to any thrown value
 * that is not already a `ToolError`. Handlers are expected to throw a
 * `ToolError` directly with the correct category; this argument is the
 * safety net for executor failures and unknown code paths.
 */
export async function runHandler<T>(
  handler: ToolHandlerFunction<T>,
  input: RawToolInput,
  context: ToolHandlerContext,
  defaultCategory: ToolErrorCategory = "internal",
): Promise<ToolExecutionResult<T>> {
  try {
    const data = await handler(input, context);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: toToolError(error, defaultCategory) };
  }
}

/**
 * Tiny validation helper: read a string property from the untrusted input
 * and reject anything that is not a non-empty string. The path is the most
 * common input — making this a single, consistent check is what stops a
 * hostile caller from slipping an object or array into a `path` field.
 *
 * On failure, the returned `ToolError` carries category "validation"
 * so dispatch flows that catch a thrown ToolError route it correctly
 * without parsing the message.
 */
export function requireString(
  input: RawToolInput,
  field: string,
):
  | { ok: true; value: string }
  | { ok: false; error: ToolError } {
  const value = input[field];
  if (typeof value !== "string") {
    return {
      ok: false,
      error: ToolError.validation(
        "tools/invalid-input",
        `Field "${field}" must be a string.`,
      ),
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      error: ToolError.validation(
        "tools/invalid-input",
        `Field "${field}" must not be empty.`,
      ),
    };
  }
  return { ok: true, value };
}

/** Re-export the ToolDefinition for handlers that want to attach to one. */
export type { ToolDefinition };

