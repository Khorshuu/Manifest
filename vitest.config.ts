import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    // Suites that stand up an in-process Postgres need longer than the
    // 10s default, both to migrate it and to reset it between tests.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
