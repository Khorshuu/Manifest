import { randomUUID } from "node:crypto";
import { CACHE_TAGS, isKnownCacheTag, setCacheInvalidationForwarder } from "@/lib/cache";
import { logEvent } from "@/lib/observability/log";
import { getLocalServicesConfig, ollamaModelFor, type LocalServicesConfig } from "@/lib/providers/local/config";
import { checkOllama } from "@/lib/providers/local/health";
import { JOB_HANDLERS, jobPolicies, RECURRING_JOBS } from "./registry";
import { runDueJobs, runLocalAiJob, scheduleRecurringJobs, type JobHandlers, type JobPolicies, type RecurringJob } from "./runner";
import { JOB_TRIGGER, recordSchedulerRun, resolveRecurringJobs } from "./schedule";
import { WORKER_HEARTBEAT } from "./mode";

/**
 * The background worker (D-133): the job trigger without the web request.
 *
 * `/api/cron/jobs` runs jobs inside a request to the web application, which
 * is right where the web application is one long-lived server and wrong
 * where it is serverless functions: those cannot reach a private search or
 * AI service and cannot stay alive for a ten-minute generation. The worker is
 * the same trigger as a process of its own — the same registry, the same
 * runner, the same claiming, heartbeats, stale recovery and local-AI lane —
 * so there is still one job system, run from a different place.
 *
 * One tick is one call of the trigger: schedule what is due in this slot, run
 * due jobs for a bounded time, record the scheduler heartbeat, and start the
 * local-AI lane without waiting for it. Ticks start on a fixed interval
 * whether or not the one before has finished, up to `maxConcurrentTicks`,
 * exactly as a scheduler's calls overlap: a research job that takes minutes
 * holds one tick, and messages still go out from the next. Every job is
 * claimed with SKIP LOCKED, so overlapping ticks — and a second worker —
 * never run one job twice.
 */

export type WorkerTickSummary = {
  scheduled: number;
  recovered: number;
  succeeded: number;
  retried: number;
  dead: number;
  disabled: string[];
};

export type WorkerDependencies = {
  handlers?: JobHandlers;
  recurring?: RecurringJob[];
  policies?: () => JobPolicies;
  /** Time a tick may spend claiming more work. */
  budgetMs?: number;
  now?: () => Date;
  /** Leaves local-AI jobs queued while the model's service is down (D-134); see `localAiServiceGate`. */
  localAiService?: { ready: () => Promise<boolean>; waitMs: number };
};

/** One call of the trigger, without the local-AI lane. */
export async function workerTick(dependencies: WorkerDependencies = {}): Promise<WorkerTickSummary> {
  const handlers = dependencies.handlers ?? JOB_HANDLERS;
  const schedule = resolveRecurringJobs(dependencies.recurring ?? RECURRING_JOBS);
  if (schedule.problems.length > 0) {
    await logEvent("error", "jobs.schedule_invalid", { problems: schedule.problems });
  }
  const now = dependencies.now;
  const scheduled = await scheduleRecurringJobs(schedule.jobs, now?.());
  const policies = (dependencies.policies ?? jobPolicies)();
  const report = await runDueJobs(handlers, { budgetMs: dependencies.budgetMs ?? 45_000, policies, localAiLane: false, now });
  const summary: WorkerTickSummary = {
    scheduled,
    recovered: report.recovered,
    succeeded: report.succeeded,
    retried: report.retried,
    dead: report.dead,
    disabled: schedule.disabled,
  };
  await recordSchedulerRun(JOB_TRIGGER, { ...summary, runner: "worker" }, now?.());
  return summary;
}

/** One attempt at the local-AI lane: at most one job, only while a slot is free. */
export async function workerLocalAiLane(dependencies: WorkerDependencies = {}): Promise<void> {
  try {
    const lane = await runLocalAiJob(dependencies.handlers ?? JOB_HANDLERS, {
      policies: (dependencies.policies ?? jobPolicies)(),
      now: dependencies.now,
      service: dependencies.localAiService,
    });
    if (lane.ran.length > 0) await logEvent("info", "jobs.local_ai", { ran: lane.ran });
  } catch (error) {
    await logEvent("error", "jobs.local_ai_failed", { error });
  }
}

/**
 * Whether the model's service can take a local-AI job now, for the worker's
 * lane (D-134). Waits only for what can clear by itself: Ollama not
 * answering, or answering without the model while it is still being pulled.
 * An address that is refused, or no model chosen, cannot clear without a
 * person, so those jobs run at once and fall back as they always have.
 *
 * Asks through the setup panel's cached probe (30 s), and logs a change of
 * state once rather than on every tick.
 */
export function localAiServiceGate(config: LocalServicesConfig = getLocalServicesConfig(), probe: typeof checkOllama = checkOllama) {
  const model = ollamaModelFor(config, "seo") ?? ollamaModelFor(config, "extraction");
  let waiting = false;
  return {
    waitMs: config.LOCAL_AI_SERVICE_WAIT_MINUTES * 60_000,
    async ready(): Promise<boolean> {
      const health = await probe(model, config);
      const ready = health.state !== "unavailable" && health.state !== "model_missing";
      if (!ready && !waiting) {
        void logEvent("warn", "worker.local_ai_waiting", { state: health.state, waitMinutes: config.LOCAL_AI_SERVICE_WAIT_MINUTES });
      } else if (ready && waiting) {
        void logEvent("info", "worker.local_ai_available", { state: health.state });
      }
      waiting = !ready;
      return ready;
    },
  };
}

export type WorkerOptions = WorkerDependencies & {
  /** Milliseconds between ticks. */
  intervalMs: number;
  /** Ticks that may be running at once; a tick due while this many run is skipped. */
  maxConcurrentTicks: number;
  /** Stops the loop; work already started is waited for, up to `shutdownGraceMs`. */
  signal: AbortSignal;
  shutdownGraceMs: number;
  /** Called after each tick that finished: the cache tags its jobs invalidated are handed over. */
  afterTick?: () => Promise<unknown>;
  /** Called about once a minute: what this worker can reach, for the health report. */
  everyMinute?: () => Promise<void>;
  /** Test seam for the wait between ticks. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called on every pass of the loop, busy or not: the container's liveness file (WORKER_ALIVE_FILE). */
  alive?: () => void;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs until `signal` aborts. Never throws for a failed tick: a database that
 * is briefly unreachable is logged and the next tick tries again, because a
 * worker that exits on the first error is a worker somebody has to restart.
 */
export async function runWorker(options: WorkerOptions): Promise<{ ticks: number; skipped: number }> {
  const sleep = options.sleep ?? abortableSleep;
  const running = new Set<Promise<void>>();
  const lanes = new Set<Promise<void>>();
  let ticks = 0;
  let skipped = 0;
  let lastMinute = 0;

  const track = (set: Set<Promise<void>>, work: Promise<void>) => {
    set.add(work);
    void work.finally(() => set.delete(work));
  };

  while (!options.signal.aborted) {
    try {
      options.alive?.();
    } catch {
      // A liveness file that cannot be written must not stop the jobs.
    }
    if (running.size >= options.maxConcurrentTicks) {
      skipped += 1;
      void logEvent("warn", "worker.tick_skipped", { running: running.size, reason: "Every tick is still busy with earlier work." });
    } else {
      ticks += 1;
      const tickId = randomUUID();
      const started = performance.now();
      track(
        running,
        workerTick(options)
          .then(async (summary) => {
            await logEvent("info", "jobs.trigger", { ...summary, runner: "worker", tickId, durationMs: Math.round(performance.now() - started) });
            await options.afterTick?.();
          })
          .catch(async (error) => {
            await logEvent("error", "worker.tick_failed", { tickId, error });
          }),
      );
      // Not awaited, like the trigger's own `after`: a generation takes minutes.
      track(lanes, workerLocalAiLane(options));
    }

    if (options.everyMinute && Date.now() - lastMinute >= 60_000) {
      lastMinute = Date.now();
      await options.everyMinute().catch((error) => logEvent("warn", "worker.report_failed", { error }));
    }

    await sleep(options.intervalMs, options.signal);
  }

  // Stopping: give work in hand a chance to finish. Whatever does not is a
  // `running` row with a worker that vanished, which stale recovery returns
  // to the queue — the same path a crash takes.
  const pending = [...running, ...lanes];
  if (pending.length > 0) {
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, options.shutdownGraceMs).unref?.())]);
  }
  return { ticks, skipped };
}

// ------------------------------------------------------- cache invalidation

const MAX_PENDING_TAGS = 1_000;

export type CacheForwarderOptions = {
  /** The web application's address, e.g. https://staging.example.com. */
  webUrl: string;
  cronSecret: string;
  /** Vercel Deployment Protection's automation bypass, when the deployment is protected. */
  bypassSecret?: string;
  fetcher?: typeof fetch;
};

/**
 * Collects the cache tags the worker's jobs invalidate and hands them to the
 * web application. Returns `flush`, which the worker calls between ticks and
 * before it stops. A failed flush keeps its tags for the next one; they are
 * bounded, because a tag set is small and repeats.
 */
export function startCacheForwarding(options: CacheForwarderOptions): { flush: () => Promise<number>; stop: () => void } {
  const pending = new Set<string>();
  const fetcher = options.fetcher ?? fetch;
  const endpoint = new URL("/api/cron/revalidate", options.webUrl);

  setCacheInvalidationForwarder((tags) => {
    for (const tag of tags) if (isKnownCacheTag(tag)) pending.add(tag);
    // The web application cannot be reached and tags are piling up: one
    // tag for every product page says the same thing in less room.
    if (pending.size > MAX_PENDING_TAGS) {
      for (const tag of pending) if (tag.startsWith("product:")) pending.delete(tag);
      pending.add(CACHE_TAGS.productPages);
    }
  });

  return {
    async flush() {
      if (pending.size === 0) return 0;
      const tags = [...pending].slice(0, 500);
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.cronSecret}`,
            ...(options.bypassSecret ? { "x-vercel-protection-bypass": options.bypassSecret } : {}),
          },
          body: JSON.stringify({ tags }),
        });
        if (response.status !== 200) {
          await logEvent("warn", "worker.cache_forward_failed", { status: response.status, tags: tags.length });
          return 0;
        }
        for (const tag of tags) pending.delete(tag);
        return tags.length;
      } catch (error) {
        await logEvent("warn", "worker.cache_forward_failed", { error, tags: tags.length });
        return 0;
      }
    },
    stop() {
      setCacheInvalidationForwarder(undefined);
    },
  };
}

export { WORKER_HEARTBEAT };
