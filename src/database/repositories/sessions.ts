/**
 * Sessions repository — the ONLY place session persistence touches Prisma.
 *
 * Boundary rules (database/README): no HTTP semantics, no Hono deps.
 * Stores only the SHA-256 hash of the opaque session token — never the raw token.
 */
import { getDatabase } from "../client.js";

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent: string | null;
}

/** Persist a session. `last_used_at` is set on first auth validation (P7-4). */
export async function createSession(input: CreateSessionInput) {
  return getDatabase().session.create({
    data: {
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent,
    },
  });
}

/** A session with its owning user — the shape the auth layer needs.
  * Deliberately selects ONLY safe user fields (no password_hash). */
export async function findSessionByTokenHash(tokenHash: string) {
  return getDatabase().session.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      userId: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
        },
      },
    },
  });
}

/** Record that a session was used. Does NOT touch expires_at (no sliding expiry). */
export async function updateSessionLastUsedAt(sessionId: string, at: Date) {
  return getDatabase().session.update({
    where: { id: sessionId },
    data: { lastUsedAt: at },
  });
}

/** Delete the session with the given token hash (logout/revocation).
  * Idempotent by design: an unknown hash matches nothing, deletes nothing,
  * and succeeds — the caller cannot learn whether the session existed. */
export async function deleteSessionByTokenHash(tokenHash: string): Promise<void> {
  await getDatabase().session.deleteMany({
    where: { tokenHash },
  });
}