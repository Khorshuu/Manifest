import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { pruneInBatches } from "@/lib/prune";
import { logEvent } from "@/lib/observability/log";
import { jobs } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { describeDatabaseError, isPermanentDatabaseError } from "@/lib/db-errors";
import { runHoldingLocalAiSlot, tryAcquireLocalAiSlot } from "@/lib/providers/local/slot";

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

/**
 * How the runner treats one kind of job (D-127). Kinds without a policy keep
 * the defaults every job had before: presumed abandoned after
 * DEFAULT_STALE_MINUTES running, no heartbeat, claimed in ordinary batches.
 */
export type JobPolicy = {
  /** Minutes a running job may go without progress before it is presumed abandoned. */
  staleAfterMinutes: number;
  /**
   * While the handler runs, `locked_at` is refreshed every `everyMs`, so a
   * legitimately long job keeps showing progress — for at most
   * `maxRuntimeMs`, after which it is left to go stale like any other, so no
   * job can stay running for ever.
   */
  heartbeat?: { everyMs: number; maxRuntimeMs: number };
  /**
   * Heavy local-model work: never claimed in an ordinary batch, where it
   * would hold up the jobs claimed with it for minutes. Claimed one at a time
   * by the local-AI lane, and only while a local-AI slot is free.
   */
  localAi?: boolean;
};

export type JobPolicies = Record<string, JobPolicy>;

export const DEFAULT_STALE_MINUTES = 15;

function localAiKinds(policies: JobPolicies): string[] {
  return Object.entries(policies)
    .filter(([, policy]) => policy.localAi)
    .map(([kind]) => kind);
}

export async function claimJobs(options: {
  workerId: string;
  limit: number;
  now?: Date;
  /** Only these kinds. */
  onlyKinds?: string[];
  /** Never these kinds. */
  excludeKinds?: string[];
}): Promise<ClaimedJob[]> {
  const now = options.now ?? new Date();
  if (options.onlyKinds !== undefined && options.onlyKinds.length === 0) return [];
  const kindFilter: SQL | undefined = options.onlyKinds
    ? inArray(jobs.kind, options.onlyKinds)
    : options.excludeKinds?.length
      ? notInArray(jobs.kind, options.excludeKinds)
      : undefined;
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), sql`${jobs.runAt} <= ${now.toISOString()}::timestamptz`, kindFilter))
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

/**
 * Returns jobs whose worker vanished to the queue, or to dead if out of
 * attempts.
 *
 * "Vanished" is judged per kind (D-127): a kind with a policy is stale after
 * its own `staleAfterMinutes` without progress, every other kind after
 * `olderThanMinutes` (DEFAULT_STALE_MINUTES). A local generation that
 * legitimately runs ten minutes is not handed to a second worker at fifteen,
 * and a notification job that has been stuck for fifteen still is.
 */
export async function recoverStaleJobs(
  options: { olderThanMinutes?: number; now?: Date; policies?: JobPolicies } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoffFor = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const policies = options.policies ?? {};
  const special = Object.keys(policies);
  const stale = or(
    ...special.map((kind) => and(eq(jobs.kind, kind), lt(jobs.lockedAt, cutoffFor(policies[kind].staleAfterMinutes)))),
    and(
      special.length ? notInArray(jobs.kind, special) : undefined,
      lt(jobs.lockedAt, cutoffFor(options.olderThanMinutes ?? DEFAULT_STALE_MINUTES)),
    ),
  );
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
    .where(and(eq(jobs.status, "running"), stale))
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

/**
 * Keeps a running job's `locked_at` current while its handler works, for a
 * kind whose policy asks for it. Returns the function that stops it.
 */
function startHeartbeat(job: ClaimedJob, workerId: string, policy: JobPolicy | undefined, clock: () => Date): () => void {
  if (!policy?.heartbeat) return () => {};
  const { everyMs, maxRuntimeMs } = policy.heartbeat;
  const began = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - began > maxRuntimeMs) {
      clearInterval(timer);
      return;
    }
    void db
      .update(jobs)
      .set({ lockedAt: clock(), updatedAt: clock() })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId), eq(jobs.status, "running")))
      .catch(() => undefined);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Runs one claimed job and records its outcome in the row and the report. */
async function runClaimedJob(
  job: ClaimedJob,
  handlers: JobHandlers,
  report: RunReport,
  context: { workerId: string; clock: () => Date; policy: JobPolicy | undefined },
): Promise<void> {
  const { workerId, clock } = context;
  const handler = handlers[job.kind];
  const started = performance.now();
  const stopHeartbeat = startHeartbeat(job, workerId, context.policy, clock);
  try {
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
      // A value the database cannot store fails the same way every time;
      // retrying only repeats whatever the handler did before it (D-119).
      const permanent = isPermanentDatabaseError(error);
      const exhausted = !handler || permanent || job.attempts >= job.maxAttempts;
      await db
        .update(jobs)
        .set({
          status: exhausted ? "dead" : "queued",
          lastError: describeDatabaseError(error, 2000),
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
        permanent,
        durationMs: Math.round(performance.now() - started),
        error,
      });
    }
  } finally {
    stopHeartbeat();
  }
}

export async function runDueJobs(
  handlers: JobHandlers,
  options: {
    workerId?: string;
    limit?: number;
    budgetMs?: number;
    now?: () => Date;
    /** Per-kind behaviour (D-127). Without it every kind is treated alike, as before. */
    policies?: JobPolicies;
    /**
     * Whether this call also runs one local-AI job at the end (the default).
     * The scheduler's route passes false and runs `runLocalAiJob` after its
     * response instead, so its own request is never held open for minutes.
     */
    localAiLane?: boolean;
  } = {},
): Promise<RunReport> {
  const workerId = options.workerId ?? randomUUID();
  const clock = options.now ?? (() => new Date());
  const started = Date.now();
  const budget = options.budgetMs ?? 45_000;
  const policies = options.policies ?? {};
  const heavy = localAiKinds(policies);
  const report: RunReport = {
    workerId,
    recovered: await recoverStaleJobs({ now: clock(), policies }),
    succeeded: 0,
    retried: 0,
    dead: 0,
    ran: [],
  };

  while (Date.now() - started < budget) {
    const claimed = await claimJobs({ workerId, limit: options.limit ?? 10, now: clock(), excludeKinds: heavy });
    if (claimed.length === 0) break;
    for (const job of claimed) {
      await runClaimedJob(job, handlers, report, { workerId, clock, policy: policies[job.kind] });
    }
  }

  if (heavy.length > 0 && options.localAiLane !== false) {
    await runLocalAiJob(handlers, { workerId, now: clock, policies, report });
  }

  return report;
}

/**
 * The local-AI lane (D-127): runs at most one due local-AI job, holding a
 * local-AI slot for the whole of it.
 *
 * The slot is taken before the job is claimed. When every slot is busy —
 * another worker, in this process or another, is generating — nothing is
 * claimed and the job stays queued for a later call, rather than a worker
 * sitting on a claimed job waiting for the model. The model calls inside the
 * handler find the slot already held and do not queue again. The slot is
 * released however the job ends.
 */
export async function runLocalAiJob(
  handlers: JobHandlers,
  options: { workerId?: string; now?: () => Date; policies: JobPolicies; report?: RunReport },
): Promise<RunReport> {
  const workerId = options.workerId ?? randomUUID();
  const clock = options.now ?? (() => new Date());
  const report: RunReport = options.report ?? { workerId, recovered: 0, succeeded: 0, retried: 0, dead: 0, ran: [] };
  const heavy = localAiKinds(options.policies);
  if (heavy.length === 0) return report;

  // Nothing due: no connection is reserved for a slot.
  const [due] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), inArray(jobs.kind, heavy), sql`${jobs.runAt} <= ${clock().toISOString()}::timestamptz`))
    .limit(1);
  if (!due) return report;

  const slot = await tryAcquireLocalAiSlot();
  if (!slot) return report;
  try {
    const [job] = await claimJobs({ workerId, limit: 1, now: clock(), onlyKinds: heavy });
    if (!job) return report;
    await runHoldingLocalAiSlot(slot, () =>
      runClaimedJob(job, handlers, report, { workerId, clock, policy: options.policies[job.kind] }),
    );
  } finally {
    await slot.release();
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
