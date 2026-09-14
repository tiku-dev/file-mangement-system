/**
 * Users repository — the ONLY place registration touches Prisma's User model.
 *
 * Boundary rules (database/README): no HTTP semantics, no Hono deps, no
 * auth/session logic. Prisma errors propagate to the service layer, which maps
 * them to HTTP. Emails are normalized (trim + lowercase) consistently here,
 * matching the case-insensitive UNIQUE (lower(email)) constraint in the database.
 */
import { getDatabase } from "../client.js";
import type { User } from "../generated/prisma/client.js";

export interface CreateUserInput {
  email: string;
  displayName: string;
  passwordHash: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Create an account. The unique lower(email) violation surfaces as Prisma P2002. */
export async function createUser(input: CreateUserInput): Promise<User> {
  return getDatabase().user.create({
    data: {
      email: normalizeEmail(input.email),
      displayName: input.displayName.trim(),
      passwordHash: input.passwordHash,
    },
  });
}

/** Case-insensitive email lookup (the table has no plain @unique — the
  * unique is the lower(email) expression index, so findFirst by normalized value.)
  */
export async function findUserByEmail(email: string): Promise<User | null> {
  return getDatabase().user.findFirst({
    where: { email: normalizeEmail(email) },
  });
}