# Database layer — boundary (Phase 6)

This directory will contain **all** database access. It is intentionally empty
of code: no client, no ORM, no schema, no migrations exist yet, and none may be
created until the Phase 6 schema is designed and approved.

Planned contents:

- Connection/client wiring — provider and ORM are deliberately undecided
  (PostgreSQL + an ORM is the current direction; chosen in Phase 6)
- Repositories per aggregate: users, files, folders, relationships, sync
  records, versions, stars, tags, activity, search metadata, duplicates,
  AI metadata, permissions
- Migrations — only after the schema is reviewed and approved

Rules for everything that will live here:

1. Only this layer imports the database driver/ORM. Routes and services never do.
2. Binary file contents never go into the relational database — they belong to
   object storage (`src/storage/`); the database stores metadata and keys.
3. Configuration comes from the environment; no credentials in source control.
4. Every query is user-scoped — authorization is enforced before data access.

## Prisma boundary (scaffolded — no database yet)

Prisma 7 is the ORM for this layer, as approved in the Phase 6 implementation
plan:

- `prisma/schema.prisma` — Prisma schema. Currently generator/datasource only;
  models are pending (the authoritative data model is `SCHEMA.md`).
- `prisma.config.ts` — CLI config: schema path, migrations path, and the
  `DATABASE_URL` datasource URL (`.env` loaded explicitly via dotenv).
- `client.ts` — lazy `PrismaClient` singleton using the `@prisma/adapter-pg`
  driver adapter. The only place that constructs PrismaClient.
- `generated/prisma/` — generated client; never committed (`pnpm db:generate`).

Scripts: `pnpm db:generate` · `pnpm db:validate` · `pnpm db:migrate` ·
`pnpm db:studio`. No migrations exist and none have been run.

The rules above are unchanged: only this directory imports `prisma`,
`@prisma/client`, `@prisma/adapter-pg`, or `pg`.
