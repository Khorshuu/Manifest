/**
 * The worker's container health check (D-134): exits 0 when the worker's loop
 * has touched WORKER_ALIVE_FILE recently, 1 otherwise.
 *
 *   node scripts/jobs/worker-alive.mjs
 *
 * Deliberately asks nothing of the database or the network. A health check
 * runs every half minute for as long as the container lives; one that logged
 * in to the email service or queried the database each time would be load,
 * and a database outage would mark the worker unhealthy and get it restarted
 * for something a restart cannot fix. The worker already survives a database
 * that comes and goes; what this catches is a worker whose loop has stopped.
 * `npm run worker -- --check` is the full report.
 *
 * "Recently" is WORKER_ALIVE_MAX_AGE_SECONDS, by default four ticks and at
 * least a minute. Plain Node, no TypeScript, so it starts in milliseconds.
 */
import { readFileSync } from "node:fs";

const file = process.env.WORKER_ALIVE_FILE?.trim();
if (!file) {
  process.stderr.write("WORKER_ALIVE_FILE is not set, so the worker writes no liveness file.\n");
  process.exit(1);
}

const interval = Number(process.env.WORKER_INTERVAL_SECONDS?.trim() || 15);
const maxAgeSeconds = Number(process.env.WORKER_ALIVE_MAX_AGE_SECONDS?.trim() || Math.max(60, interval * 4));

let touched;
try {
  touched = Number(readFileSync(file, "utf8").trim());
} catch {
  process.stderr.write("The worker has not written its liveness file yet.\n");
  process.exit(1);
}

const ageSeconds = (Date.now() - touched) / 1000;
if (!Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds) {
  process.stderr.write(`The worker's loop last ran ${Number.isFinite(ageSeconds) ? Math.round(ageSeconds) : "?"} s ago (limit ${maxAgeSeconds} s).\n`);
  process.exit(1);
}
process.exit(0);
