# Sync coordination — boundary (Phase 9)

Synchronization is split across two sides. Only the backend side lives here.

## Backend side (this directory, Phase 9)

- Per-user change log / sync queue (append-only change events from desktops)
- Version history and conflict-detection metadata
- `/api/sync*` endpoints: push changes, pull changes, transfer bytes (through
  `src/storage/`), status, retries
- Idempotency and resumability: interrupted transfers must be safe to retry
  without duplicating data or corrupting versions

## Desktop side (NOT here)

- Lives in the desktop app (future `src/services/sync/` plus Rust helpers where
  needed): watching the local filesystem through `FilesystemProvider`, hashing,
  queuing uploads/downloads, applying remote changes to disk.
- The backend never receives arbitrary filesystem access — only explicit file
  transfers for files the user chose to sync.
