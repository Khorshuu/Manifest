import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Background jobs (migration 0024, DECISIONS.md D-053). */
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** Unique while set: the same recurring slot or event is enqueued once. */
    dedupeKey: text("dedupe_key"),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    /** For staff; never shown to a customer. */
    lastError: text("last_error"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'dead')`,
    ),
    check("jobs_max_attempts_check", sql`${table.maxAttempts} > 0`),
    uniqueIndex("jobs_dedupe_key_unique").on(table.dedupeKey).where(sql`${table.dedupeKey} is not null`),
    index("jobs_due_idx").on(table.runAt).where(sql`${table.status} = 'queued'`),
    index("jobs_running_idx").on(table.lockedAt).where(sql`${table.status} = 'running'`),
    index("jobs_kind_status_idx").on(table.kind, table.status),
    // The last finished run of each kind, for the job screen (migration 0041).
    index("jobs_kind_finished_idx")
      .on(table.kind, table.finishedAt.desc())
      .where(sql`${table.finishedAt} is not null`),
  ],
);

/** When each scheduler trigger last ran (migration 0030, D-059). */
export const schedulerHeartbeats = pgTable("scheduler_heartbeats", {
  name: text("name").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  lastReport: jsonb("last_report").notNull().default({}),
});
