import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { pruneInBatches } from "@/lib/prune";
import { logEvent } from "@/lib/observability/log";
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

/** postgres-js returns an array; other drivers wrap it in `.rows`. */
function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return rows ?? [];
}

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

/**
 * Enqueues a job unless one of the same kind is already waiting or running.
 *
 * `dedupeKey` cannot express this. Its unique index is not scoped to a status,
 * so a constant key is claimed by the first job for ever and every later
 * enqueue is silently dropped, while a key that varies — a time slot, a UUID —
 * stops deduplicating the thing that actually matters: *is this work already
 * going to happen?*
 *
 * That is the question a drain worker asks. `rebuildSearchIndex` queues the
 * catalogue and wants a worker started; `processSearchQueue` wants to continue
 * itself past one function's time budget. Both are satisfied by one pending
 * job, and a press-happy operator must not be able to fill the table with
 * workers that will race each other over the same queue.
 *
 * **Why this is a transaction and not one clever statement.** The obvious
 * version — `insert … select … where not exists (…)`, with an advisory lock
 * taken in the `from` clause — looks race-free and is not. Under READ
 * COMMITTED a statement takes its snapshot when it *starts*, not when it stops
 * waiting for a lock, so twenty callers arriving together all take a snapshot
 * showing no pending job, then serialise on the lock, then each insert against
 * the stale snapshot. The lock changes the order and nothing else. The check
 * has to be a separate statement issued *after* the wait, because that is what
 * gets a snapshot including whatever the previous holder committed.
 *
 * `excludeJobId` is how a handler continues itself: while it runs, its own row
 * is `running` and would otherwise be the reason it refuses to enqueue its
 * successor. A handler passes the `jobId` it was given, which excludes exactly
 * one row and still refuses when any *other* worker of that kind is pending.
 *
 * Returns true when this call is the one that enqueued.
 */
export async function enqueueUniquePending(
  input: EnqueueInput & { excludeJobId?: string },
  executor: Executor = db,
): Promise<boolean> {
  const exclude = input.excludeJobId ?? null;

  return executor.transaction(async (tx: Executor) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`jobs:pending:${input.kind}`}, 0))`);

    // Issued after the wait, so its snapshot includes the row the previous
    // holder of the lock committed.
    const found = await tx.execute(sql`
      select 1 from jobs
      where kind = ${input.kind}
        and status in ('queued', 'running')
        and (${exclude}::uuid is null or id <> ${exclude}::uuid)
      limit 1
    `);
    if (rowsOf(found).length > 0) return false;

    const inserted = await tx.execute(sql`
      insert into jobs (kind, payload, run_at, max_attempts)
      values (${input.kind}, ${JSON.stringify(input.payload ?? {})}::jsonb,
              ${(input.runAt ?? new Date()).toISOString()}::timestamptz, ${input.maxAttempts ?? 5})
      returning id
    `);
    return rowsOf(inserted).length > 0;
  });
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
      const started = performance.now();
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
        void logEvent("info", "job.succeeded", {
          jobId: job.id,
          kind: job.kind,
          attempt: job.attempts,
          durationMs: Math.round(performance.now() - started),
        });
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
        void logEvent(exhausted ? "error" : "warn", exhausted ? "job.dead" : "job.retrying", {
          jobId: job.id,
          kind: job.kind,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          durationMs: Math.round(performance.now() - started),
          error,
        });
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
  const [counts, problems, lastRuns] = await Promise.all([
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
    /*
     * The most recent finished run of each kind, with what it reported.
     *
     * Counts say how many jobs are in each state and the problem list says
     * which failed, but neither answers the question an operator actually
     * has: *what did it do?* The media sweep reports how many files it
     * reclaimed and how many it stores with no row behind them; the search
     * drain reports what is left to rebuild; the prune reports what it
     * removed. All of that was being written to `jobs.result` and read by
     * nobody.
     */
    // `distinct on` with the matching index reads one row per kind rather than
    // every finished job — the every-minute delivery job alone leaves ten
    // thousand of those inside its retention (migration 0041).
    db.execute(sql`
      select distinct on (kind)
             kind, status, finished_at, attempts, result, last_error
      from jobs
      where finished_at is not null
      order by kind, finished_at desc
    `),
  ]);

  return {
    counts,
    problems: problems.filter((job) => job.status === "dead" || job.lastError),
    lastRuns: rowsOf(lastRuns).map((row) => {
      const run = row as {
        kind: string;
        status: string;
        finished_at: Date | string;
        attempts: number;
        result: unknown;
        last_error: string | null;
      };
      return {
        kind: run.kind,
        status: run.status,
        finishedAt: new Date(run.finished_at),
        attempts: Number(run.attempts),
        result: run.result,
        lastError: run.last_error,
      };
    }),
  };
}

/** Deletes finished jobs older than the given age; failures are kept longer. */
export async function pruneFinishedJobs(options: { succeededDays?: number; deadDays?: number } = {}) {
  const now = Date.now();
  const removed = await pruneInBatches(
    jobs,
    sql`(${jobs.status} = 'succeeded' and ${jobs.finishedAt} < ${new Date(now - (options.succeededDays ?? 7) * 86_400_000).toISOString()}::timestamptz)
        or (${jobs.status} = 'dead' and ${jobs.finishedAt} < ${new Date(now - (options.deadDays ?? 30) * 86_400_000).toISOString()}::timestamptz)`,
  );
  return removed.removed;
}
