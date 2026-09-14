/**
 * Application error type shared by all future endpoints.
 *
 * Every error the API returns carries an HTTP status and a stable,
 * machine-readable `code` ("area/reason") so clients can branch on codes
 * without parsing human messages.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static notFound(what: string): AppError {
    return new AppError(404, "common/not-found", `${what} was not found.`);
  }

  static notConfigured(what: string): AppError {
    return new AppError(503, "common/not-configured", `${what} is not configured yet.`);
  }

  static badRequest(message: string): AppError {
    return new AppError(400, "common/bad-request", message);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }

  static unauthorized(): AppError {
    return new AppError(
      401,
      "auth/unauthorized",
      "Invalid email or password.",
    );
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
