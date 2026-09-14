import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma CLI configuration (Prisma 7).
 *
 * - schema:         prisma/schema.prisma (models pending — the authoritative
 *                   data model is src/database/SCHEMA.md)
 * - datasource url: read from DATABASE_URL, loaded explicitly via dotenv
 *                   (Prisma 7 no longer auto-loads .env files)
 *
 * `prisma validate` / `prisma generate` do not connect to a database.
 * Migrations are a separate, later task.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});