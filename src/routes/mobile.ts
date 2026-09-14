/** Mobile-facing AI planning endpoints. */
import { Hono } from "hono";
import { getCurrentUser, requireAuth, type AppVariables } from "../core/auth.js";
import { AppError } from "../core/errors.js";
import { getMobileCapabilities, planMobileAgent } from "../services/mobileAgent.js";

export const mobileRoutes = new Hono<AppVariables>()
  .get("/capabilities", requireAuth, (c) => {
    getCurrentUser(c);
    return c.json(getMobileCapabilities(), 200);
  })
  .post("/plan", requireAuth, async (c) => {
    getCurrentUser(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw AppError.badRequest("Request body must be valid JSON.");
    }
    return c.json(await planMobileAgent(body), 200);
  });
