/**
 * Hono application factory.
 *
 * Kept separate from index.ts so the app can be created without binding a
 * port (tests and future tooling).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { onError, onNotFound } from "./core/http.js";
import { apiRoutes } from "./routes/index.js";

export function createApp(): Hono {
  const app = new Hono();

  // Browser/webview origins allowed to call the API (see config.ts).
  app.use("/api/*", cors({ origin: config.corsOrigins }));

  app.notFound(onNotFound);
  app.onError(onError);

  app.route("/api", apiRoutes);

  return app;
}
