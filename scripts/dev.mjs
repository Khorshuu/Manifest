/**
 * Local development: the web server and the background scheduler, together
 * (D-121).
 *
 *   npm run dev [-- --port 3000 --every 15]
 *
 * Product preparation, research, message delivery and every other background
 * job run only when something calls /api/cron/jobs. In production that is the
 * hosted scheduler; on a development machine it was `npm run jobs:dev` in a
 * second terminal, and forgetting it left preparation "Working…" for ever. This
 * starts both and supervises them:
 *
 *  - `next dev` (the same as `npm run dev:web`), its lines prefixed [web];
 *  - once the server answers, exactly one `scripts/jobs/dev-scheduler.mjs`
 *    calling it, its lines prefixed [jobs].
 *
 * The scheduler only calls the web server's own trigger, so it always drains
 * the database the web server uses, through the same route production uses:
 * no second job system and no worker inside request handling. Jobs are claimed
 * with SKIP LOCKED, so even a second scheduler started by hand could not run
 * one job twice.
 *
 * Ctrl+C, or either process exiting, stops both.
 *
 * Nothing here is used in production or by the browser tests, which start
 * `npm run dev:web` so their preparation runs are not driven by a scheduler.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What to start, from the command line and the environment. Pure, for tests. */
export function devPlan(argv = [], env = {}) {
  const option = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };
  const port = String(option("port", env.PORT ?? "3000"));
  const every = String(option("every", env.DEV_JOBS_EVERY ?? "15"));
  if (!/^\d+$/.test(port)) throw new Error(`--port must be a number, not "${port}".`);
  if (!/^\d+$/.test(every) || Number(every) < 1) throw new Error(`--every must be a whole number of seconds, not "${every}".`);
  const base = `http://localhost:${port}`;
  return {
    base,
    web: {
      name: "web",
      command: env.DEV_WEB_COMMAND ?? process.execPath,
      args: env.DEV_WEB_COMMAND ? JSON.parse(env.DEV_WEB_ARGS ?? "[]") : [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "--port", port],
    },
    jobs: {
      name: "jobs",
      command: process.execPath,
      args: [join(ROOT, "scripts", "jobs", "dev-scheduler.mjs"), "--base", base, "--every", every],
    },
  };
}

/** Prefixes every line a child writes, so the two logs can be told apart. */
export function prefixed(name, line) {
  return `[${name}] ${line}`;
}

function pipe(child, name) {
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      (stream === child.stderr ? process.stderr : process.stdout).write(`${prefixed(name, line)}\n`);
    });
  }
}

function start(spec, extraEnv = {}) {
  const child = spawn(spec.command, spec.args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group on POSIX, so stopping it stops what it started.
    detached: process.platform !== "win32",
  });
  pipe(child, spec.name);
  return child;
}

/** Stops a child and everything it started. */
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

async function waitUntilAnswering(base, web, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (web.exitCode !== null) return false;
    try {
      // Any answer means the server is up; the scheduler's own call compiles its route.
      await fetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(5_000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return false;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const plan = devPlan(argv, env);
  const children = [];
  let stopping = false;

  const shutdown = (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) stop(child);
    process.exitCode = code;
    // Give the children a moment to go, then leave whatever is left.
    setTimeout(() => process.exit(code), 1_500).unref();
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  // A parent killed outright (a closed tool, a killed npm) sends no signal on
  // Windows; without this the supervisor and both children outlive it.
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      shutdown(0);
    }
  }, 2_000).unref();

  const web = start(plan.web);
  children.push(web);
  web.on("exit", (code) => {
    if (!stopping) console.error(prefixed("dev", `the web server stopped (${code ?? "signal"}); stopping the scheduler too.`));
    shutdown(code ?? 1);
  });

  console.log(prefixed("dev", `web server starting on ${plan.base}; background jobs start once it answers.`));
  if (!(await waitUntilAnswering(plan.base, web))) {
    if (!stopping) {
      console.error(prefixed("dev", "the web server did not answer; background jobs were not started."));
      shutdown(1);
    }
    return;
  }
  if (stopping) return;

  const jobs = start(plan.jobs);
  children.push(jobs);
  console.log(prefixed("dev", `background jobs: calling ${plan.base}/api/cron/jobs every ${plan.jobs.args.at(-1)} s.`));
  jobs.on("exit", (code) => {
    if (!stopping) console.error(prefixed("dev", `the background scheduler stopped (${code ?? "signal"}); stopping the web server too.`));
    shutdown(code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(prefixed("dev", error.message));
    process.exit(1);
  });
}
