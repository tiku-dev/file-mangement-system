# Smart File Manager — Backend

The backend owns the **cloud side** of the Smart File Manager: user accounts
(future), synced file metadata, and synced file content (future). It is an
independent TypeScript/Node.js service, deliberately decoupled from the desktop.

**It must never have access to a user's local filesystem.** The desktop app owns
local files through Tauri → Rust → OS. The backend only ever receives files the
desktop sync engine explicitly uploads, and serves them only to authorized
clients (authorization arrives with authentication, Phase 7).

## Architecture

```
Desktop app ──sync──▶ ┌─────────┐      ┌──────────────────────────┐
Web app     ──────────▶ HTTP API ────▶ │ Backend (this service)   │
                      └─────────┘      │  ├─ Database   (Phase 6) │
                                       │  └─ Object storage (Ph 8)│
                                       └──────────────────────────┘
```

- **Desktop:** React → `FilesystemProvider` → `DesktopFilesystemProvider` → Tauri/Rust → local FS
- **Cloud:** Desktop sync engine (Phase 9) → HTTP API → this backend → DB + storage
- **Web:** React → HTTP API → this backend → DB + storage

## Run

```sh
pnpm install
pnpm dev        # tsx watch → http://127.0.0.1:4000
pnpm typecheck  # tsc --noEmit
pnpm build      # tsc → dist/
pnpm start      # node dist/index.js
```

### Environment (no secrets yet — and secrets must never live in source)

| Variable       | Default                  | Meaning                                     |
| -------------- | ------------------------ | ------------------------------------------- |
| `PORT`         | `4000`                   | HTTP port                                   |
| `HOST`         | `127.0.0.1`              | Bind address (loopback by default)          |
| `CORS_ORIGINS` | local dev origins        | Comma-separated origins allowed by CORS     |

`CORS_ORIGINS` also matters for the desktop app later: Tauri v2 webviews have
origins like `tauri://localhost` (macOS/Linux) / `http://tauri.localhost`
(Windows), which will need to be allow-listed when the desktop calls the API
(Phase 9).

## Structure

| Path            | Responsibility                                                  |
| --------------- | --------------------------------------------------------------- |
| `src/index.ts`  | Bootstrap only: config, HTTP server, graceful shutdown          |
| `src/app.ts`    | Hono app factory: middleware, error policy, `/api` mount        |
| `src/config.ts` | Typed env-driven config (no secrets in source)                  |
| `src/routes/`   | One module per feature, mounted in `routes/index.ts`            |
| `src/core/`     | Cross-cutting: `AppError`, single JSON error envelope           |
| `src/database/` | Boundary for Phase 6 — see its README (no DB code exists yet)   |
| `src/storage/`  | Boundary for Phase 8 — see its README (no storage code yet)     |
| `src/sync/`     | Boundary for Phase 9 — see its README (no sync code yet)        |

## API surface (today)

- `GET /api/health` — liveness plus **honest** component statuses. The only
  endpoint, deliberately.

## Intentionally NOT implemented yet

Database/ORM/migrations (Phase 6) · authentication (Phase 7) · object storage
(Phase 8) · sync (Phase 9) · search/indexing, duplicates, storage intelligence,
AI (Phases 11–14). Nothing here fakes any of it — components report
`not-configured` / `not-implemented` until they are real.
