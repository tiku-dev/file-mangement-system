import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * Database boundary — the ONLY place in the backend that constructs the
 * Prisma client. Routes and services must reach the database through
 * repositories built on this module, never through Prisma directly
 * (see ./README.md rule 1).
 *
 * The client is created lazily so that importing this module never opens a
 * connection and never fails when DATABASE_URL is absent — misconfiguration
 * surfaces only on first actual use.
 */

export type DatabaseClient = PrismaClient;

let instance: PrismaClient | undefined;

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not configured. Copy backend/.env.example to backend/.env and set it.",
    );
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

/** Shared PrismaClient singleton (one connection pool per process). */
export function getDatabase(): PrismaClient {
  instance ??= createClient();
  return instance;
}

/** The database server's current time — used for authoritative expiry comparisons
  * (session TTL semantics must not depend on client/Node clock accuracy). */
export async function databaseNow(): Promise<Date> {
  const rows = (await getDatabase().$queryRaw`SELECT now() AS "now"`) as Array<{ now: Date | string }>;
  const first = rows[0];
  if (!first) throw new Error("Database clock query returned no rows.");
  return first.now instanceof Date ? first.now : new Date(first.now);
}

/** For graceful shutdown wiring later — not called anywhere yet. */
export async function disconnectDatabase(): Promise<void> {
  await instance?.$disconnect();
  instance = undefined;
}