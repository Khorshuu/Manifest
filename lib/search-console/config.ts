import { z } from "zod";

/**
 * How the shop synchronises Search Console, read separately from the
 * credentials (which live in the provider and nowhere else).
 *
 * Every setting has a working default, so connecting Search Console needs one
 * variable and a key, not a configuration exercise.
 */
const schema = z.object({
  /** How far back a first sync reaches. Google keeps about 16 months. */
  SEARCH_CONSOLE_BACKFILL_DAYS: z.coerce.number().int().min(1).max(480).default(90),
  /**
   * How many recent days every sync re-reads on top of the watermark. Search
   * Console revises the last few days after first reporting them, so the
   * trailing window is re-fetched and upserted rather than trusted once.
   */
  SEARCH_CONSOLE_REFRESH_DAYS: z.coerce.number().int().min(1).max(30).default(5),
  /**
   * The most recent day worth asking for. Search Console lags behind by a
   * couple of days, and asking for yesterday mostly returns nothing.
   */
  SEARCH_CONSOLE_LAG_DAYS: z.coerce.number().int().min(0).max(10).default(2),
  /** Rows per provider request. Google's ceiling is 25,000. */
  SEARCH_CONSOLE_ROW_LIMIT: z.coerce.number().int().min(100).max(25_000).default(5_000),
  /** A ceiling on one sync, so a mistake cannot run for an hour. */
  SEARCH_CONSOLE_MAX_REQUESTS: z.coerce.number().int().min(1).max(500).default(60),
  /** How long measurements are kept. Older days are pruned by the maintenance job. */
  SEARCH_CONSOLE_RETENTION_DAYS: z.coerce.number().int().min(30).max(900).default(480),
});

export type SearchConsoleConfig = z.infer<typeof schema>;

export function getSearchConsoleConfig(): SearchConsoleConfig {
  const values = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, process.env[key]?.trim() || undefined]),
  );
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid Search Console configuration: ${issues}`);
  }
  return parsed.data;
}

/** ISO day, as Search Console spells dates. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}
