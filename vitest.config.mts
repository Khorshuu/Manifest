import { defineConfig } from "vitest/config";

/**
 * Two groups, run in order.
 *
 * `unit` is everything on in-process PGlite: independent databases, safe to run
 * in parallel. `real-postgres` is the concurrency suites that race many
 * connections against the server from `npm run db:server`. Each opens a pool of
 * 20+ connections, and run side by side with each other and the dev server
 * they exhausted the server's 100-connection limit — a teardown then waited on
 * a connection that never came and timed out. They run one file at a time,
 * after the unit group.
 *
 * ESM (`.mts`) so Vite does not load the config as CommonJS, and path aliases
 * come from Vite's own `resolve.tsconfigPaths` rather than a plugin.
 */
const REAL_POSTGRES = ["tests/*-concurrency.test.ts"];

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Suites that stand up a Postgres need longer than the 10s default, both
    // to migrate it and to reset it between tests.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
          exclude: REAL_POSTGRES,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "real-postgres",
          environment: "node",
          include: REAL_POSTGRES,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
