import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { isPooledUrl } from "@/db/connection";
import { jobs, schedulerHeartbeats } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { isWorkerProcess, jobRunnerMode, WORKER_HEARTBEAT } from "@/lib/jobs/mode";
import { jobPolicies, RECURRING_JOBS } from "@/lib/jobs/registry";
import { DEFAULT_STALE_MINUTES } from "@/lib/jobs/runner";
import { resolveRecurringJobs, schedulerHealth } from "@/lib/jobs/schedule";
import { MAX_DELIVERY_ATTEMPTS } from "@/lib/notifications/outbox";
import { researchSetup, WORKER_REPORT_STALE_MS, type ResearchSetupItem } from "@/lib/preparation/setup";
import { getLocalServicesConfig, localServiceUrl, ollamaModelFor } from "@/lib/providers/local/config";
import { getNotificationProvider, type NotificationProviderHealth } from "@/lib/providers/notification";
import { getMediaProvider } from "@/lib/providers/media";

/**
 * One answer to "is this environment working?" (D-133), for the people who
 * run it: the database, the job queue and whoever drains it, message
 * delivery, and the research and AI services.
 *
 * Composed from checks that already existed — the scheduler heartbeat, the
 * job table, the outbox, the service probes behind the owner's setup panel —
 * so it reports what the rest of the application believes rather than a
 * second opinion.
 *
 * States, counts and sentences only. It never returns an address, a host
 * name, a key, a token, a prompt, or anything read from a customer; the
 * routes that serve it are for staff and for a monitor holding CRON_SECRET,
 * and it would be safe if it leaked anyway.
 */

export type HealthStatus = "ok" | "degraded" | "down";

export type SystemHealth = {
  status: HealthStatus;
  checkedAt: string;
  /** What is wrong, in sentences an operator can act on. Empty when `ok`. */
  problems: string[];
  database: { state: "ok" | "unreachable"; latencyMs: number | null; pooled: boolean };
  jobs: {
    runner: "scheduler" | "worker";
    /** Whoever drains the queue called in recently enough for the schedule. */
    schedulerStale: boolean;
    lastRunAt: string | null;
    expectedEveryMinutes: number | null;
    queued: number;
    /** Queued and already due: work that is waiting for a worker right now. */
    due: number;
    oldestDueMinutes: number | null;
    running: number;
    /** Running with no progress for longer than its kind allows: presumed abandoned. */
    stale: number;
    dead: number;
    /** Local-AI jobs waiting for the model. */
    localAiQueued: number;
  };
  worker: { state: "not_used" | "reporting" | "silent"; lastReportAt: string | null };
  notifications: {
    provider: NotificationProviderHealth;
    queued: number;
    sending: number;
    /** Failed with attempts left: will be tried again without anyone acting. */
    retrying: number;
    /** Failed for good: needs a person. */
    failed: number;
    oldestQueuedMinutes: number | null;
  };
  research: { key: string; state: string; status: string }[];
  ai: { provider: string; model: string | null; remote: boolean; concurrency: number; lockConnection: "direct" | "pooled" };
  media: { provider: string };
  /** Named so nobody reads a staging environment as taking real money or booking real couriers. */
  payment: { provider: string };
  shipping: { provider: string };
};

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

function minutesSince(value: unknown, now: number): number | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null;
}

async function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const UNKNOWN_PROVIDER: NotificationProviderHealth = {
  provider: "unknown",
  state: "unavailable",
  message: "The notification provider did not answer its health check in time.",
};

export async function systemHealth(now: Date = new Date()): Promise<SystemHealth> {
  const env = getEnv();
  const local = getLocalServicesConfig();
  const runner = jobRunnerMode();
  const problems: string[] = [];
  const pooled = isPooledUrl(env.DATABASE_URL);

  // Everything else reads the database, so when it is down that is the whole answer.
  const started = performance.now();
  let reachable = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    reachable = false;
  }
  const latencyMs = reachable ? Math.round(performance.now() - started) : null;

  const ollamaAddress = localServiceUrl(local.OLLAMA_BASE_URL, local.OLLAMA_ALLOW_REMOTE);
  const usesLocalAi = env.PRODUCT_EXTRACTION_PROVIDER === "ollama" || (process.env.SEO_PULSE_AI_PROVIDER ?? "").trim() === "ollama";
  const base: Pick<SystemHealth, "checkedAt" | "database" | "ai" | "media" | "payment" | "shipping"> = {
    checkedAt: now.toISOString(),
    database: { state: reachable ? "ok" : "unreachable", latencyMs, pooled },
    ai: {
      provider: usesLocalAi ? "ollama" : "none",
      model: usesLocalAi ? (ollamaModelFor(local, "seo") ?? ollamaModelFor(local, "extraction")) : null,
      remote: ollamaAddress.ok && ollamaAddress.remote,
      concurrency: local.LOCAL_AI_CONCURRENCY,
      lockConnection: pooled ? "pooled" : "direct",
    },
    media: { provider: mediaProviderName() },
    payment: { provider: env.PAYMENT_PROVIDER },
    shipping: { provider: env.SHIPPING_PROVIDER },
  };

  if (!reachable) {
    return {
      ...base,
      status: "down",
      problems: ["The database could not be reached."],
      jobs: { runner, schedulerStale: true, lastRunAt: null, expectedEveryMinutes: null, queued: 0, due: 0, oldestDueMinutes: null, running: 0, stale: 0, dead: 0, localAiQueued: 0 },
      worker: { state: runner === "worker" ? "silent" : "not_used", lastReportAt: null },
      notifications: { provider: UNKNOWN_PROVIDER, queued: 0, sending: 0, retrying: 0, failed: 0, oldestQueuedMinutes: null },
      research: [],
    };
  }

  const schedule = resolveRecurringJobs(RECURRING_JOBS);
  const policies = jobPolicies();
  const localAiKinds = Object.entries(policies)
    .filter(([, policy]) => policy.localAi)
    .map(([kind]) => kind);
  const nowIso = now.toISOString();

  const [scheduler, jobRows, runningRows, outboxRows, workerRows, provider, research] = await Promise.all([
    schedulerHealth(schedule.jobs, now),
    db.execute(sql`
      select count(*) filter (where status = 'queued')::int as queued,
             count(*) filter (where status = 'queued' and run_at <= ${nowIso}::timestamptz)::int as due,
             min(run_at) filter (where status = 'queued' and run_at <= ${nowIso}::timestamptz) as oldest_due,
             count(*) filter (where status = 'running')::int as running,
             count(*) filter (where status = 'dead')::int as dead
      from jobs
    `),
    db.execute(sql`select kind, locked_at from jobs where status = 'running'`),
    db.execute(sql`
      select count(*) filter (where status = 'queued')::int as queued,
             count(*) filter (where status = 'sending')::int as sending,
             count(*) filter (where status = 'failed' and attempts < ${MAX_DELIVERY_ATTEMPTS})::int as retrying,
             count(*) filter (where status = 'failed' and attempts >= ${MAX_DELIVERY_ATTEMPTS})::int as failed,
             min(created_at) filter (where status = 'queued') as oldest_queued
      from notifications
    `),
    db
      .select({ lastRunAt: schedulerHeartbeats.lastRunAt })
      .from(schedulerHeartbeats)
      .where(eq(schedulerHeartbeats.name, WORKER_HEARTBEAT)),
    bounded(getNotificationProvider().health?.() ?? Promise.resolve(UNKNOWN_PROVIDER), 8_000, UNKNOWN_PROVIDER),
    bounded<ResearchSetupItem[]>(researchSetup(), 12_000, []),
  ]);

  const job = rowsOf(jobRows)[0] ?? {};
  const outbox = rowsOf(outboxRows)[0] ?? {};
  const stale = rowsOf(runningRows).filter((row) => {
    const minutes = minutesSince(row.locked_at, now.getTime());
    const allowed = policies[String(row.kind)]?.staleAfterMinutes ?? DEFAULT_STALE_MINUTES;
    return minutes !== null && minutes > allowed;
  }).length;
  const localAiQueued = localAiKinds.length
    ? Number(
        (
          await db
            .select({ waiting: count() })
            .from(jobs)
            .where(and(eq(jobs.status, "queued"), inArray(jobs.kind, localAiKinds)))
        )[0]?.waiting ?? 0,
      )
    : 0;

  const workerLast = workerRows[0]?.lastRunAt ?? null;
  const workerState: SystemHealth["worker"]["state"] =
    runner !== "worker" ? "not_used" : workerLast && now.getTime() - workerLast.getTime() <= WORKER_REPORT_STALE_MS ? "reporting" : "silent";

  const health: SystemHealth = {
    ...base,
    status: "ok",
    problems,
    jobs: {
      runner,
      schedulerStale: scheduler.stale,
      lastRunAt: scheduler.lastRunAt?.toISOString() ?? null,
      expectedEveryMinutes: scheduler.expectedEveryMinutes,
      queued: Number(job.queued ?? 0),
      due: Number(job.due ?? 0),
      oldestDueMinutes: minutesSince(job.oldest_due, now.getTime()),
      running: Number(job.running ?? 0),
      stale,
      dead: Number(job.dead ?? 0),
      localAiQueued,
    },
    worker: { state: workerState, lastReportAt: workerLast?.toISOString() ?? null },
    notifications: {
      provider,
      queued: Number(outbox.queued ?? 0),
      sending: Number(outbox.sending ?? 0),
      retrying: Number(outbox.retrying ?? 0),
      failed: Number(outbox.failed ?? 0),
      oldestQueuedMinutes: minutesSince(outbox.oldest_queued, now.getTime()),
    },
    research: research.map((item) => ({ key: item.key, state: item.state, status: item.status })),
  };

  if (scheduler.stale) {
    problems.push(
      runner === "worker"
        ? "The background worker has not run jobs recently. Scheduled work, message delivery and research are waiting."
        : "The scheduler has not called the job trigger recently. Scheduled work and message delivery are waiting.",
    );
  }
  if (workerState === "silent") problems.push("The background worker is not reporting what it can reach.");
  if (schedule.problems.length > 0) problems.push("JOB_SCHEDULE has entries that were ignored.");
  if (health.jobs.stale > 0) problems.push(`${health.jobs.stale} running job(s) have shown no progress for longer than they should and will be recovered.`);
  if (health.jobs.dead > 0) problems.push(`${health.jobs.dead} job(s) are dead and need a person to look at them.`);
  if (provider.state === "unavailable" || provider.state === "not_configured") problems.push(`Notifications: ${provider.message}`);
  if (health.notifications.failed > 0) problems.push(`${health.notifications.failed} message(s) failed for good and were not delivered.`);
  if ((health.notifications.oldestQueuedMinutes ?? 0) > 15) problems.push("Messages have been waiting to be sent for more than 15 minutes.");
  for (const item of health.research) {
    if (item.state === "unavailable" || item.state === "missing_key") problems.push(`Research (${item.key}): ${item.status}.`);
  }
  // A pooled address cannot hold the local-AI slot. Only the process that
  // runs the jobs matters: with a worker, the web application never takes it.
  if (usesLocalAi && pooled && (runner === "scheduler" || isWorkerProcess())) {
    problems.push("Local AI is configured, but this process reaches the database through a pooler; the local-AI slot needs the direct address.");
  }

  // Nothing above stops a shopper buying: the storefront does not wait on any of it.
  health.status = problems.length > 0 ? "degraded" : "ok";
  return health;
}

function mediaProviderName(): string {
  try {
    return (getMediaProvider() as { name?: string }).name ?? "unknown";
  } catch {
    return "misconfigured";
  }
}
