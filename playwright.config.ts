import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const databaseName = process.env.E2E_DATABASE_NAME ?? "preorder_e2e";
const adminUrl =
  process.env.E2E_ADMIN_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const testDatabaseUrl = adminUrl.replace(/\/[^/]*$/, `/${databaseName}`);

/**
 * E2E_PRODUCTION runs the suite against a production build rather than the dev
 * server. It is the only way to measure the real JavaScript payload, since
 * next dev serves unminified, uncompressed modules.
 */
const isProduction = process.env.E2E_PRODUCTION === "1";

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
    command: isProduction ? "npm run start" : "npm run dev",
    url: baseURL,
    env: {
      // Login throttling is real behaviour, but a suite that signs in on every
      // spec would trip it. Disabled for the test server only; the flag is
      // ignored entirely when NODE_ENV is production.
      RATE_LIMIT_DISABLED: "1",
      // The suite gets its own database, so it never writes into the
      // developer catalog.
      DATABASE_URL: testDatabaseUrl,
      ...(isProduction
        ? {
            NODE_ENV: "production",
            // The bypass is ignored in production by design, so the suite
            // raises the configured ceiling rather than asking for a backdoor.
            LOGIN_RATE_LIMIT_PER_IP: "100000",
            LOGIN_RATE_LIMIT_PER_ACCOUNT: "100000",
          }
        : {}),
    },
    timeout: isProduction ? 120_000 : 60_000,
    // The dev server must pick up that DATABASE_URL, so never reuse one that
    // is already running against the development database.
    reuseExistingServer: false,
  },
});
