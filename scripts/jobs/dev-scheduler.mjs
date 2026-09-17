/**
 * A local stand-in for the production scheduler (D-059).
 *
 *   npm run jobs:dev [-- --base http://localhost:3000 --every 60]
 *
 * Calls /api/cron/jobs with CRON_SECRET (from the environment or .env.local)
 * every --every seconds until stopped, so background work — unpaid-order
 * expiry, message delivery, publish dates — happens on a development machine
 * the way it does in production. Nothing here runs by itself: without this
 * script, or a real scheduler in a hosted environment, those jobs do not run.
 */
import { readFileSync } from "node:fs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function secretFromEnvFile() {
  try {
    const line = readFileSync(".env.local", "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("CRON_SECRET="));
    return line?.slice("CRON_SECRET=".length).replace(/^"|"$/g, "");
  } catch {
    return undefined;
  }
}

const base = option("base", "http://localhost:3000");
const everySeconds = Number(option("every", "60"));
const secret = process.env.CRON_SECRET ?? secretFromEnvFile();

if (!secret) {
  console.error("Set CRON_SECRET (in the environment or .env.local) to the value the server uses.");
  process.exit(1);
}

async function tick() {
  const started = new Date();
  try {
    const response = await fetch(`${base}/api/cron/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const body = await response.text();
    console.log(`${started.toISOString()} ${response.status} ${body}`);
  } catch (error) {
    console.log(`${started.toISOString()} unreachable: ${error.message}`);
  }
}

await tick();
setInterval(tick, everySeconds * 1000);
