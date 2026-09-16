/**
 * GET /api/health — the one endpoint in this foundation phase.
 *
 * It reports honest status: what is actually wired, and what is deliberately
 * not built yet. Statuses here are updated as each phase lands — never faked.
 */
import { Hono } from "hono";
import { getDatabase } from "../database/client.js";
import { getAiRuntimeStatus } from "../services/aiStatus.js";

/** Components that are deliberately not built yet — unchanged statuses. */

/** Components that are deliberately not built yet — unchanged statuses. */
const COMPONENT_STATUSES = {
  objectStorage: "not-required",
  sync: "not-required",
  authentication: "ok",
  mobileApi: "ready",
} as const;

/** How long the database liveness probe may take before reporting an error. */
const DATABASE_TIMEOUT_MS = 5000;

/** Real liveness probe: `SELECT 1` against the PostgreSQL database. */
async function checkDatabase(): Promise<"ok" | "error"> {
  try {
    await Promise.race([
      getDatabase().$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Database liveness probe timed out")), DATABASE_TIMEOUT_MS);
        // Don't let a hung probe keep the process alive after shutdown.
        timer.unref();
      }),
    ]);
    return "ok";
  } catch {
    // Never leak database internals to clients — just an honest status.
    return "error";
  }
}

export const healthRoutes = new Hono().get("/", async (c) => {
  const database = await checkDatabase();
  const ai = getAiRuntimeStatus().status === "ok" ? "configured" : "not-configured";
  return c.json({
    status: "ok",
    service: "smart-file-manager-backend",
    time: new Date().toISOString(),
    components: { ...COMPONENT_STATUSES, ai, database },
  });
});
