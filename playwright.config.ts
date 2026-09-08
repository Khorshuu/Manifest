import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const databaseName = process.env.E2E_DATABASE_NAME ?? "preorder_e2e";
const adminUrl =
  process.env.E2E_ADMIN_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const testDatabaseUrl = adminUrl.replace(/\/[^/]*$/, `/${databaseName}`);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    env: {
      // Login throttling is real behaviour, but a suite that signs in on every
      // spec would trip it. Disabled for the test server only; the flag is
      // ignored entirely when NODE_ENV is production.
      RATE_LIMIT_DISABLED: "1",
      // The suite gets its own database, so it never writes into the
      // developer catalog.
      DATABASE_URL: testDatabaseUrl,
    },
    // The dev server must pick up that DATABASE_URL, so never reuse one that
    // is already running against the development database.
    reuseExistingServer: false,
  },
});
