/**
 * API route registry.
 *
 * Each future feature (files, sync, stars, search, ...) gets its own module
 * mounted here under /api. Routes stay thin and delegate to services; services
 * delegate to the database/storage layers (Phases 6 and 8).
 */
import { Hono } from "hono";
import { healthRoutes } from "./health.js";
import { authRoutes } from "./auth.js";
import { aiRoutes } from "./ai.js";
import type { AppVariables } from "../core/auth.js";

export const apiRoutes = new Hono<AppVariables>()
  .route("/health", healthRoutes)
  .route("/auth", authRoutes)
  .route("/ai", aiRoutes);
