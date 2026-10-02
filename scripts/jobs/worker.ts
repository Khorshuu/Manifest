/**
 * The background worker (D-133, docs/STAGING.md).
 *
 *   npm run worker                 run until stopped
 *   npm run worker -- --once       one tick, wait for it, exit
 *   npm run worker -- --check      report what this worker can reach, exit 0 or 1
 *
 * A long-running process that does what `/api/cron/jobs` does without a web
 * request: schedules recurring work, runs due jobs, delivers messages, runs
 * research and local-AI jobs. For an environment where the web application is
 * serverless and the search and AI services are private — set JOB_RUNNER=worker
 * on both, so the web application's trigger declines and this runs the queue.
 *
 * Its DATABASE_URL must be the database's direct address, not a pooled one:
 * the local-AI slot is a session advisory lock. It refuses to start otherwise
 * when local AI is configured.
 *
 * Stopping (SIGTERM, SIGINT) lets work in hand finish for a short while; a
 * job cut off is returned to the queue by stale recovery, as after a crash.
 * Restarting is the service manager's job (systemd, a container's restart
 * policy, the platform's process supervisor) — this never restarts itself.
 */
import "../../lib/load-env";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { getEnv } from "../../lib/env";
import { systemHealth } from "../../lib/health";
import { jobRunnerMode, markWorkerProcess, WORKER_HEARTBEAT } from "../../lib/jobs/mode";
import { recordSchedulerRun } from "../../lib/jobs/schedule";
import { runWorker, startCacheForwarding, workerLocalAiLane, workerTick } from "../../lib/jobs/worker";
import { startErrorReporting } from "../../lib/observability/error-reporting";
import { logEvent } from "../../lib/observability/log";
import { researchSetup } from "../../lib/preparation/setup";
import { getLocalServicesConfig } from "../../lib/providers/local/config";
import { slotConnectionProblem } from "../../lib/providers/local/slot";

function numberFrom(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function usesLocalAi(): boolean {
  return getEnv().PRODUCT_EXTRACTION_PROVIDER === "ollama" || process.env.SEO_PULSE_AI_PROVIDER?.trim() === "ollama";
}

async function main() {
  markWorkerProcess();
  const env = getEnv();
  // Before anything can fail: an error-level event here is reported like one
  // in the web application, when SENTRY_DSN is set.
  const errorTracking = await startErrorReporting();
  const once = process.argv.includes("--once");
  const check = process.argv.includes("--check");

  const intervalMs = numberFrom("WORKER_INTERVAL_SECONDS", 15, 5, 600) * 1000;
  const maxConcurrentTicks = numberFrom("WORKER_MAX_CONCURRENT_TICKS", 3, 1, 8);
  const shutdownGraceMs = numberFrom("WORKER_SHUTDOWN_GRACE_SECONDS", 25, 0, 600) * 1000;

  // Refused before anything is claimed: with a pooled address the slot's
  // lock is not a lock, and two generations would share one graphics card.
  const slotProblem = usesLocalAi() ? slotConnectionProblem(env.DATABASE_URL) : null;
  if (slotProblem) {
    await logEvent("error", "worker.refused_to_start", { reason: slotProblem.message });
    process.exit(1);
  }

  // A database that is not there is the one thing worth failing fast on.
  await db.execute(sql`select 1`);

  if (check) {
    const health = await systemHealth();
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    process.exit(health.status === "down" ? 1 : 0);
  }

  if (jobRunnerMode() !== "worker") {
    await logEvent("warn", "worker.runner_mode", {
      reason: "JOB_RUNNER is not 'worker', so the web application's job trigger will also run jobs if anything calls it. No job runs twice, but a job the web application claims cannot reach services private to this worker.",
    });
  }

  const webUrl = (process.env.WORKER_WEB_URL ?? process.env.SITE_URL)?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const cache =
    webUrl && cronSecret
      ? startCacheForwarding({ webUrl, cronSecret, bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || undefined })
      : null;
  if (!cache) {
    await logEvent("warn", "worker.cache_forward_off", {
      reason: "WORKER_WEB_URL (or SITE_URL) and CRON_SECRET are not both set, so storefront pages this worker changes refresh only when their cache lifetime lapses.",
    });
  }

  const local = getLocalServicesConfig();
  const startedAt = new Date().toISOString();
  await logEvent("info", "worker.started", {
    intervalSeconds: intervalMs / 1000,
    maxConcurrentTicks,
    runner: jobRunnerMode(),
    localAi: usesLocalAi(),
    localAiConcurrency: local.LOCAL_AI_CONCURRENCY,
    research: env.PRODUCT_RESEARCH_PROVIDER,
    browserRenderer: local.LOCAL_BROWSER_RENDERER,
    notifications: env.NOTIFICATION_PROVIDER,
    cacheForwarding: Boolean(cache),
    errorTracking,
    node: process.version,
  });

  /** What this worker can reach, for the web application's setup panel and health check. */
  const report = async () => {
    await recordSchedulerRun(WORKER_HEARTBEAT, { startedAt, services: await researchSetup() });
  };

  if (once) {
    const summary = await workerTick();
    await workerLocalAiLane();
    await cache?.flush();
    await report();
    await logEvent("info", "jobs.trigger", { ...summary, runner: "worker", once: true });
    process.exit(0);
  }

  const controller = new AbortController();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    void logEvent("info", "worker.stopping", { signal, graceSeconds: shutdownGraceMs / 1000 });
    controller.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const result = await runWorker({ intervalMs, maxConcurrentTicks, shutdownGraceMs, signal: controller.signal, afterTick: async () => cache?.flush(), everyMinute: report });
  await cache?.flush();
  await logEvent("info", "worker.stopped", result);
  process.exit(0);
}

main().catch(async (error) => {
  await logEvent("error", "worker.crashed", { error });
  process.exit(1);
});
