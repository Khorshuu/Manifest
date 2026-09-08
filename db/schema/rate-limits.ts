import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Attempt counters, shared by every process.
 *
 * A fixed window per key: one row per (key, window start), incremented
 * atomically. The previous limiter was a Map inside one Node process, which
 * meant the limit reset on every deploy and counted separately on every
 * serverless instance — the deployment target is exactly the case it did not
 * cover (docs/SECURITY.md).
 *
 * `key` is a SHA-256 hash, never the address or email itself: a table of who
 * tried to sign in and when is worth less to an attacker if it does not name
 * anyone.
 */
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    // Old windows are swept in the background; this is the index that makes
    // the sweep cheap.
    index("rate_limit_hits_window_idx").on(table.windowStart),
  ],
);
