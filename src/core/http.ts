/**
 * Central HTTP response policies: one JSON error envelope for the whole API.
 *
 * Shape: { "error": { "code": "area/reason", "message": "..." } }
 */
import type { ErrorHandler, NotFoundHandler } from "hono";
import { isAppError } from "./errors.js";

export interface ApiErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return Response.json(body, { status });
}

/**
 * `AppError`s pass through with their own status/code; anything unexpected is
 * logged and reduced to a generic 500 so internals never leak to clients.
 */
export const onError: ErrorHandler = (error) => {
  if (isAppError(error)) {
    return errorResponse(error.status, error.code, error.message);
  }
  console.error("[backend] unhandled error:", error);
  return errorResponse(500, "internal/error", "Internal server error.");
};

export const onNotFound: NotFoundHandler = (c) =>
  errorResponse(404, "common/not-found", `No route for ${c.req.method} ${c.req.path}.`);
