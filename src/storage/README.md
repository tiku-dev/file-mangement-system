# Object storage layer — boundary (Phase 8)

This directory will contain the object/file-storage adapter that holds the
**contents** of synced files. Empty of code by design: no provider has been
chosen yet (an S3-compatible service or a local volume are the candidates;
decided deliberately in Phase 8).

Planned contents:

- An `ObjectStorage` port (put / get / delete / stream / presigned URLs) with
  swappable implementations, so the rest of the backend never depends on a
  specific vendor
- A key scheme derived from user IDs and file UUIDs — never from
  client-supplied paths or names
- Streaming upload/download so large files are never fully buffered in memory

Rules:

1. Storage keys are generated server-side; client-provided names are metadata,
   never keys.
2. Downloads/uploads are authorized per user and per file before any byte is
   transferred.
3. The database (`src/database/`) stores metadata and storage keys; file
   contents live only here.
