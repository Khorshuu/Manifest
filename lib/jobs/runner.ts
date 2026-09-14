import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";

/**
 * The job runner (DECISIONS.md D-053).
 *
 * Jobs live in Postgres. A worker claims due rows with FOR UPDATE SKIP LOCKED,
 * runs the handler for each kind, and records the outcome: succeeded, queued
 * again with exponential backoff, or dead once its attempts run out, where a
 * person can see it and retry it. A worker that dies mid-job leaves a row
 * `running`; the next run returns it to the queue.
 *
 * Handlers must be idempotent: a job can run again after a crash between its
 * effect and the row being marked. Every handler registered here already is —
 * each guards its own writes (lib/jobs/registry.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the base database or
   an open transaction; they differ only in generics */
type Executor = any;

export type JobHandler = (
  payload: Record<string, unknown>,
  context: { jobId: string; attempt: number },
) => Promise<unknown>;

export type JobHandlers = Record<string, JobHandler>;

export class UnknownJobKindError extends Error {
  constructor(kind: string) {
    super(`No handler is registered for jobs of kind "${kind}".`);
    this.name = "UnknownJobKindError";
  }
}

export type EnqueueInput = {
  kind: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  /** Unique while set: a second enqueue with the same key is ignored. */
  dedupeKey?: string;
  maxAttempts?: number;
};

/** Enqueues a job, inside the caller's transaction when one is passed. */
export async function enqueueJob(input: EnqueueInput, executor: Executor = db): Promise<boolean> {
  const rows = await executor.execute(sql`
    insert into jobs (kind, payload, dedupe_key, run_at, max_attempts)
    values (${input.kind}, ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.dedupeKey ?? null},
            ${(input.runAt ?? new Date()).toISOString()}::timestamptz, ${input.maxAttempts ?? 5})
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning id
  `);
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return list.length > 0;
}

export type RecurringJob = { kind: string; everyMinutes: number; maxAttempts?: number };

/**
 * Enqueues each recurring job for the time slot `now` falls in. The slot is
 * the dedupe key, so several triggers inside one slot schedule it once.
 */
export async function scheduleRecurringJobs(recurring: RecurringJob[], now: Date = new Date()): Promise<number> {
  let scheduled = 0;
  for (const job of recurring) {
    const size = job.everyMinutes * 60_000;
    const slot = new Date(Math.floor(now.getTime() / size) * size);
    if (
      await enqueueJob({
        kind: job.kind,
        runAt: slot,
        dedupeKey: `${job.kind}@${slot.toISOString()}`,
        maxAttempts: job.maxAttempts ?? 3,
      })
    ) {
      scheduled += 1;
    }
  }
  return scheduled;
}

/** Seconds before attempt `attempt + 1`: 30 s, 1 min, 2 min … capped at an hour. */
export function backoffSeconds(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
}

type ClaimedJob = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
};

export async function claimJobs(options: { workerId: string; limit: number; now?: Date }): Promise<ClaimedJob[]> {
  const now = options.now ?? new Date();
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), sql`${jobs.runAt} <= ${now.toISOString()}::timestamptz`))
    .orderBy(asc(jobs.runAt), asc(jobs.createdAt))
    .limit(options.limit)
    .for("update", { skipLocked: true });

  return db
    .update(jobs)
    .set({
      status: "running",
      lockedAt: now,
      lockedBy: options.workerId,
      attempts: sql`${jobs.attempts} + 1`,
      updatedAt: now,
    })
    .where(inArray(jobs.id, due))
    .returning({
      id: jobs.id,
      kind: jobs.kind,
      payload: jobs.payload,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
    }) as Promise<ClaimedJob[]>;
}

/** Returns jobs whose worker vanished to the queue, or to dead if out of attempts. */
export async function recoverStaleJobs(options: { olderThanMinutes?: number; now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMinutes ?? 15) * 60_000);
  const recovered = await db
    .update(jobs)
    .set({
      status: sql`case when ${jobs.attempts} >= ${jobs.maxAttempts} then 'dead' else 'queued' end`,
      lockedAt: null,
      lockedBy: null,
      lastError: "The worker stopped before finishing.",
      runAt: now,
      updatedAt: now,
    })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });
  return recovered.length;
}

export type RunReport = {
  workerId: string;
  recovered: number;
  succeeded: number;
  retried: number;
  dead: number;
  ran: { id: string; kind: string; outcome: "succeeded" | "retried" | "dead" }[];
};

export async function runDueJobs(
  handlers: JobHandlers,
  options: { workerId?: string; limit?: number; budgetMs?: number; now?: () => Date } = {},
): Promise<RunReport> {
  const workerId = options.workerId ?? randomUUID();
  const clock = options.now ?? (() => new Date());
  const started = Date.now();
  const budget = options.budgetMs ?? 45_000;
  const report: RunReport = {
    workerId,
    recovered: await recoverStaleJobs({ now: clock() }),
    succeeded: 0,
    retried: 0,
    dead: 0,
    ran: [],
  };

  while (Date.now() - started < budget) {
    const claimed = await claimJobs({ workerId, limit: options.limit ?? 10, now: clock() });
    if (claimed.length === 0) break;

    for (const job of claimed) {
      const handler = handlers[job.kind];
      try {
        if (!handler) throw new UnknownJobKindError(job.kind);
        const result = await handler(job.payload ?? {}, { jobId: job.id, attempt: job.attempts });
        await db
          .update(jobs)
          .set({
            status: "succeeded",
            result: (result ?? null) as object | null,
            lastError: null,
            lockedAt: null,
            finishedAt: clock(),
            updatedAt: clock(),
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId)));
        report.succeeded += 1;
        report.ran.push({ id: job.id, kind: job.kind, outcome: "succeeded" });
      } catch (error) {
        const exhausted = !handler || job.attempts >= job.maxAttempts;
        await db
          .update(jobs)
          .set({
            status: exhausted ? "dead" : "queued",
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
            lockedAt: null,
            lockedBy: null,
            runAt: new Date(clock().getTime() + backoffSeconds(job.attempts) * 1000),
            finishedAt: exhausted ? clock() : null,
            updatedAt: clock(),
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId)));
        if (exhausted) report.dead += 1;
        else report.retried += 1;
        report.ran.push({ id: job.id, kind: job.kind, outcome: exhausted ? "dead" : "retried" });
      }
    }
  }

  return report;
}

/** Puts a dead job back in the queue with fresh attempts. The owner only. */
export async function retryDeadJob(actor: SessionUser | null, jobId: string) {
  requirePermission(actor, "settings.manage");
  const [row] = await db
    .update(jobs)
    .set({ status: "queued", attempts: 0, runAt: new Date(), lastError: null, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "dead")))
    .returning({ id: jobs.id, kind: jobs.kind });
  if (!row) throw new NotFoundError("No dead job has that id.");
  return row;
}

/** Counts by kind and status, and the most recent failures, for staff. */
export async function jobSummary(actor: SessionUser | null) {
  requirePermission(actor, "notifications.view");
  const [counts, problems] = await Promise.all([
    db
      .select({ kind: jobs.kind, status: jobs.status, total: count() })
      .from(jobs)
      .groupBy(jobs.kind, jobs.status)
      .orderBy(asc(jobs.kind), asc(jobs.status)),
    db
      .select({
        id: jobs.id,
        kind: jobs.kind,
        status: jobs.status,
        attempts: jobs.attempts,
        lastError: jobs.lastError,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(inArray(jobs.status, ["dead", "queued"]))
      .orderBy(sql`${jobs.updatedAt} desc`)
      .limit(20),
  ]);
  return { counts, problems: problems.filter((job) => job.status === "dead" || job.lastError) };
}

/** Deletes finished jobs older than the given age; failures are kept longer. */
export async function pruneFinishedJobs(options: { succeededDays?: number; deadDays?: number } = {}) {
  const now = Date.now();
  const removed = await db
    .delete(jobs)
    .where(
      sql`(${jobs.status} = 'succeeded' and ${jobs.finishedAt} < ${new Date(now - (options.succeededDays ?? 7) * 86_400_000).toISOString()}::timestamptz)
        or (${jobs.status} = 'dead' and ${jobs.finishedAt} < ${new Date(now - (options.deadDays ?? 30) * 86_400_000).toISOString()}::timestamptz)`,
    )
    .returning({ id: jobs.id });
  return removed.length;
}
