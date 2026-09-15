# Mobile API integration

The backend plans operations; the mobile app performs them locally. It never
gets a device filesystem permission, path allow-list bypass, or direct file
handle. This keeps a user's phone storage under the mobile OS permission model.

## Setup

Put a newly rotated Groq credential in `backend/.env`, not in the app and not
in source control:

```dotenv
GROQ_API_KEY=your_new_key
GROQ_MODEL=llama-3.3-70b-versatile
AI_PROVIDER=groq
AI_PROVIDER_FALLBACK=groq
```

Confirm `GET /api/health` returns `database: "ok"` and `ai: "configured"`.
The key is server-only; mobile clients authenticate to this API with the token
from `POST /api/auth/login`.

## Mobile flow

1. Log in or register, then send `Authorization: Bearer <token>` on all calls.
2. Call `GET /api/mobile/bootstrap` to load the authenticated user, privacy
   boundary, UI feature flags, AI provider status, and mobile capabilities in
   one request.
3. Call `GET /api/mobile/capabilities` to discover the supported operation
   schemas and which calls require confirmation.
4. Send a prompt to `POST /api/mobile/plan`.
5. For read operations, the app validates paths against its local allow-list,
   executes through Android/iOS APIs, and sends a small metadata result back in
   the next `/plan` request.
6. Before every operation whose `requiresApproval` is `true`, display the
   exact proposed operation to the user. Execute it only after approval.
7. Send the result back to `/plan` with the same original instruction. Repeat
   until the response has no operations.

`/api/mobile/bootstrap` does not return phone files or storage statistics. The
Flutter client owns those values because the backend never has access to the
phone filesystem. The client can use the returned feature flags and
capabilities to render the Home, Browse, Search, Settings, Activity, and AI
Assistant screens shown in the design.

Example planning request:

```json
{ "instruction": "Move my PDF reports from Downloads into Documents." }
```

The response has `execution: "client-side"`; `operations` are proposals, not
proof that the server changed any phone file.

## Current operations

`list_directory`, `search_files`, and `get_file_metadata` are read-only.
`move_file` is approval-required and can also rename a file when the destination
has a different name. Raw-content reads are intentionally not offered to the
mobile planner. Delete, create-folder, and folder-move operations are not yet
implemented, so clients must not present them as available.

The mobile app must independently enforce scoped storage / sandbox paths,
re-check that the source and destination still exist immediately before a
write, prevent overwrite, and report only metadata or a short summary—never
file contents—to this API.
