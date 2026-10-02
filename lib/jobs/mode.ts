/**
 * Which process runs background jobs in this environment (D-133).
 *
 *  - `scheduler` (the default): whatever calls `/api/cron/jobs` — Vercel Cron,
 *    an external cron service, `npm run dev` — runs them inside the web
 *    application, as it always has.
 *  - `worker`: a long-running process started with `npm run worker` runs them,
 *    and the web application's trigger declines. This is the setting for an
 *    environment whose research and AI services are private to the worker: a
 *    serverless function cannot reach them and cannot stay alive for a
 *    ten-minute generation, so a job it claimed would fail for reasons that
 *    have nothing to do with the job.
 *
 * `JOB_RUNNER` is set to the same value on the web application and on the
 * worker. Either way jobs are claimed with SKIP LOCKED, so a mistake here can
 * make a job fail or wait, and can never make one run twice.
 */

export type JobRunnerMode = "scheduler" | "worker";

export function jobRunnerMode(value: string | undefined = process.env.JOB_RUNNER): JobRunnerMode {
  return value?.trim().toLowerCase() === "worker" ? "worker" : "scheduler";
}

let workerProcess = false;

/** Called once by the worker's entrypoint; nothing else sets it. */
export function markWorkerProcess(): void {
  workerProcess = true;
}

/** Whether this process is the worker itself rather than the web application. */
export function isWorkerProcess(): boolean {
  return workerProcess;
}

/** Test helper. */
export function setWorkerProcessForTesting(value: boolean): void {
  workerProcess = value;
}

/** The name the worker records what it can reach under, in `scheduler_heartbeats`. */
export const WORKER_HEARTBEAT = "worker";
