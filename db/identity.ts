/**
 * Which database a connection actually reached (D-134).
 *
 * A connection string is only a claim. Every environment has its own
 * database — staging is `manifest_staging`, never the development, end-to-end,
 * scale-test or production one — and the only way to know which one a string
 * reaches is to connect and ask `current_database()`. These checks run on
 * that answer, before anything is written.
 *
 * Database names are not secrets, so the messages name them; nothing here
 * ever sees a password or a host.
 */

/** Names that are never a staging database: development, tests, scale data, and providers' defaults. */
const DEVELOPMENT_NAMES = new Set(["preorder", "preorder_utf8", "preorder_e2e"]);
const PROVIDER_DEFAULTS = new Set(["postgres", "neondb", "defaultdb", "template0", "template1"]);
const SCRATCH_OR_TEST = /(^|_)(e2e|test|scale|bench|perf|load|loadtest|scratch)(_|\d|$)/i;

/**
 * Why `actual` is not the database this environment expects, or null. With
 * no expectation set there is nothing to compare, and nothing is refused:
 * EXPECTED_DATABASE_NAME is the opt-in.
 */
export function databaseIdentityProblem(actual: string, expected: string | undefined): string | null {
  const want = expected?.trim();
  if (!want) return null;
  if (actual === want) return null;
  return `Connected to database "${actual}", but EXPECTED_DATABASE_NAME is "${want}". Nothing was changed. Check which database this connection string points at.`;
}

/**
 * Why `name` cannot be a staging database, or null. A provider's default
 * database is refused too: a project's first database is where production
 * usually lives, and staging gets one created for it.
 */
export function stagingDatabaseProblem(name: string): string | null {
  const lower = name.toLowerCase();
  if (DEVELOPMENT_NAMES.has(lower)) return `"${name}" is a development database, not staging.`;
  if (PROVIDER_DEFAULTS.has(lower)) return `"${name}" is a provider's default database, where production usually lives; staging has its own (manifest_staging).`;
  if (SCRATCH_OR_TEST.test(lower) || lower.startsWith("manifest_scale")) return `"${name}" is named as a test or scratch database, not staging.`;
  return null;
}
