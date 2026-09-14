/**
 * Authentication middleware (Phase 7) — validates a Bearer session token and
 * establishes a typed, safe user context before protected handlers run.
 *
 * All authentication failures — missing/malformed/unknown token, expired
 * session, disabled user — return the SAME generic 401 auth/unauthorized, so
 * an attacker cannot distinguish them (no session/enumeration leakage).
 */
import { createHash } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { AppError } from "./errors.js";
import { databaseNow } from "../database/client.js";
import {
  findSessionByTokenHash,
  updateSessionLastUsedAt,
} from "../database/repositories/sessions.js";

/** An authenticated (safe) user, established on Hono's context by requireAuth. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
}

/** Per-request Hono context variables used by the auth layer. */
export interface AppVariables {
  Variables: {
    user?: AuthUser;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Strictly parse `Authorization: Bearer <token>` and return the RAW token.
  * Any failure (missing header, wrong scheme, empty/malformed value) throws the
  * same generic 401 auth/unauthorized used by every authentication path — the
  * caller can never distinguish the failure reason. */
export function getBearerToken(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const header = c.req.header("authorization");
  if (!header) throw AppError.unauthorized();
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme !== "Bearer" || !token || token.length === 0 || rest.length > 0) {
    throw AppError.unauthorized();
  }
  return token;
}

/** Hono middleware that authenticates the current request. */
export const requireAuth = createMiddleware(async (c, next) => {
  try {
    const token = getBearerToken(c);

    const session = await findSessionByTokenHash(sha256(token));
    if (!session) throw new Error("unknown");
    if (session.user.status !== "active") throw new Error("inactive");
    // Compare against the DATABASE's clock — session TTL semantics must not
    // depend on the Node process's wall-clock accuracy or the driver's parsing.

    const dbNow = await databaseNow();
    if (session.expiresAt.getTime() <= dbNow.getTime()) throw new Error("expired");

    // Smallest-safe activity tracking: record last_used_at WITHOUT extending
    // expires_at. Not a sliding-expiration mechanism.

    try {
      await updateSessionLastUsedAt(session.id, new Date());
    } catch {
      // Non-fatal: a failed activity stamp must not block an otherwise valid
      // request. The raw/ hashed token is not logged here..
    }

    c.set("user", {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      status: session.user.status,
    } satisfies AuthUser);

    await next();
  } catch {
    // Uniform, uninformative authentication failure..
    throw AppError.unauthorized();
  }
});

/** Read the authenticated user established by requireAuth. Call only after it. */
export function getCurrentUser(c: { get: (key: string) => unknown }): AuthUser {
  const user = c.get("user");
  if (!user) throw AppError.unauthorized();
  return user as AuthUser;
}