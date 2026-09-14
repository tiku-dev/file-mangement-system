/**
 * Authentication service (Phase 7) — registration only.
 *
 * Routes stay thin: this service owns validation, normalization, hashing,
 * and duplicate detection. Login/logout/session issuance arrive in later steps.
 */
import * as bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../core/errors.js";
import { config } from "../config.js";
import { createUser, findUserByEmail } from "../database/repositories/users.js";
import { createSession, deleteSessionByTokenHash } from "../database/repositories/sessions.js";

/** Safe user representation — never includes password_hash or anything else secret. */
export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: Date;
}

export interface LoginResult {
  user: SafeUser;
  token: string;
}

export interface RegisterInput {
  email: unknown;
  displayName: unknown;
  password: unknown;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 255;
const MIN_PASSWORD_LENGTH = 8;
/** Production-intent bcrypt cost factor. 12 rounds ≈ 250ms per hash — appropriate
  * for account registration (login verification lands with P7-3). */
const BCRYPT_ROUNDS = 12;
const EMAIL_TAKEN_CODE = "auth/email-taken";
/** Dummy bcrypt hash computed once at module load: used when the login email is
  * unknown, so the bcrypt work factor is identical for known/unknown emails and
  * login timing cannot reveal whether an account exists (enumeration defense). */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("smart-file-manager-dummy-password", BCRYPT_ROUNDS);

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toSafeUser(user: {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: Date;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
  };
}

/** Validate + create an account. Never logs the user in — session issuance is P7-3. */
export async function registerUser(input: RegisterInput): Promise<SafeUser> {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";

  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw AppError.badRequest("A valid email address is required.");
  }
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw AppError.badRequest(`Display name must be 1–${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw AppError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }

  if (await findUserByEmail(email)) {
    throw AppError.conflict(EMAIL_TAKEN_CODE, "An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const user = await createUser({ email, displayName, passwordHash });
    return toSafeUser(user);
  } catch (error) {
    // Race-condition backstop: a concurrent request may have created the
    // email between our check and the insert — Prisma surfaces the UNIQUE
    // (lower(email)) violation as P2002; map it to the same 409.
    if (isUniqueConstraintViolation(error)) {
      throw AppError.conflict(EMAIL_TAKEN_CODE, "An account with this email already exists.");
    }
    throw error;
  }
}
export interface LoginInput {
  email: unknown;
  password: unknown;
  userAgent: string | null;
}

/** SHA-256 of the raw opaque token — the only thing ever persisted. */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken,"utf8").digest("hex");
}

/** Cryptographically secure opaque bearer token: 32 random bytes, hex-encoded (64 chars. */
function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export async function loginUser(input: LoginInput): Promise<LoginResult> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";

  // Malformed login INPUT is a 400 validation error — not an authentication failure.


  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw AppError.badRequest("A valid email address is required.");
  }
  if (password.length === 0) {
    throw AppError.badRequest("Password is required.");
  }

  const user = await findUserByEmail(email);
  // Run bcrypt against the same-cost dummy hash for unknown emails, so the
  // time cost is identical whether or not an account exists (enumeration defense).
  const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await bcrypt.compare(password, passwordHash);
  if (!user || !passwordMatches) {
    throw AppError.unauthorized();
  }

  if (user.status !== "active") {
    // Same generic error: do not reveal that the account is disabled..
    throw AppError.unauthorized();
  }

  // Opaque bearer token — returned to the client exactly once, transiently.in
  // memory and the HTTP response; only its SHA-256 hash is persisted. No JWT..
  const rawToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  await createSession({
    userId: user.id,
    tokenHash: hashToken(rawToken),
    expiresAt,
    // Only the User-Agent header, if present. No IP addresses or other tracking.



    userAgent: input.userAgent,
  });

  return { user: toSafeUser(user), token: rawToken };
}

/** Revoke the session identified by the raw bearer token (logout).
  * Idempotent: revoking an unknown/already-revoked token is a silent success —
  * the response must not reveal whether the session existed. */
export async function logoutUser(rawToken: string): Promise<void> {
  await deleteSessionByTokenHash(hashToken(rawToken));
}