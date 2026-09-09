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
  /*
   * Sixty seconds rather than the default thirty.
   *
   * The suite runs against `next dev`, which compiles routes on demand, and
   * eight parallel workers share one server process. As the suite grew, tests
   * began timing out in the middle of ordinary navigations — a sign-in
   * redirect, a response wait — while passing comfortably on their own. That
   * is a budget problem, not a defect, and the honest fix is to admit the work
   * takes longer rather than to keep marking individual tests slow until they
   * all are.
   *
   * The assertion timeout stays much shorter than the test timeout on purpose:
   * a missing element should fail in seconds with a useful message, not sit
   * there consuming the whole budget.
   */
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
      // A known secret, so the scheduled sweep can be exercised the way a real
      // scheduler calls it.
      CRON_SECRET: "test-cron-secret",
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
