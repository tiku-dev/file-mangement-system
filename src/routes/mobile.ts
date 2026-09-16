/** Mobile-facing AI planning endpoints. */
import { Hono } from "hono";
import { getCurrentUser, requireAuth, type AppVariables } from "../core/auth.js";
import { AppError } from "../core/errors.js";
import {
  getMobileBootstrap,
  getMobileCapabilities,
  planMobileAgent,
} from "../services/mobileAgent.js";
import { getAiRuntimeStatus } from "../services/aiStatus.js";

export const mobileRoutes = new Hono<AppVariables>()
  .get("/bootstrap", requireAuth, (c) => {
    const user = getCurrentUser(c);
    return c.json(getMobileBootstrap(user, getAiRuntimeStatus()), 200);
  })
  .get("/capabilities", requireAuth, (c) => {
    getCurrentUser(c);
    return c.json(getMobileCapabilities(), 200);
  })
  .post("/plan", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw AppError.badRequest("Request body must be valid JSON.");
    }
    return c.json(await planMobileAgent(body), 200);
  });
