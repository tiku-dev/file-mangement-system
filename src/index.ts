/**
 * Server bootstrap — the only entrypoint. All application wiring lives in
 * app.ts; this file reads config, binds the port, and handles shutdown.
 */
// Load backend/.env into the process BEFORE config is read, so `pnpm dev` /
// `pnpm start` work with the documented environment (dotenv does not override
// variables already present in the shell). Backend-only secrets stay in .env.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { disconnectDatabase } from "./database/client.js";

const app = createApp();

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    console.log(`[backend] listening on http://${info.address}:${info.port}`);
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[backend] ${signal} received, shutting down`);
    server.close(async (error) => {
      // Close the database connection pool before exiting — the HTTP server
      // has stopped accepting new requests, so no in-flight query is interrupted..
      try {
        await disconnectDatabase();
      } catch (disconnectError) {
        console.error("[backend] error closing database pool:", disconnectError);
      }
      process.exit(error ? 1 : 0);
    });
  });
}
