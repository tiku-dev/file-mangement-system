import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * The backend is ESM (NodeNext). Vitest resolves source modules with the
 * same `.js` ↔ `.ts` import mapping that `tsc` enforces, and treats
 * `src/**` as the project root so `import "./foo.js"` resolves to
 * `src/foo.ts` exactly like in production.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
  resolve: {
    extensions: [".ts", ".js", ".mjs", ".json"],
  },
});
