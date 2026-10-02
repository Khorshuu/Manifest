/**
 * Is this a working staging configuration? (D-134, docs/STAGING.md)
 *
 *   npm run staging:check -- --role worker --env-file .env.staging
 *   npm run staging:check -- --role web --env-file .env.staging.web
 *
 * Reads one role's settings — the worker's, or the web application's as
 * Vercel holds them (`vercel env pull --environment=preview .env.staging.web`)
 * — and reports READY, WARNING or MISSING per area. Then, unless `--offline`,
 * checks the services those settings name: which database each address
 * reaches and over what, its migrations, a session lock, an SMTP login, one
 * SearXNG query, Ollama's model list.
 *
 * Writes nothing anywhere: no migration, no upload, no email, no job. Prints
 * no value — no address, password, token or recipient. Exits 1 when anything
 * is MISSING.
 *
 * Options:
 *   --role web|worker          whose settings these are (default: worker)
 *   --env-file <path>          read settings from this file only; without it,
 *                              from the process environment only (never
 *                              .env.local, which is development's)
 *   --expect-database <name>   overrides EXPECTED_DATABASE_NAME
 *   --offline                  settings only, no connections
 *   --json                     the report as JSON
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import type { CheckItem, StagingRole } from "../../lib/staging/config-check";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const role = (argument("--role") ?? "worker") as StagingRole;
  if (role !== "web" && role !== "worker") throw new Error("--role must be web or worker.");
  const envFile = argument("--env-file");
  const offline = process.argv.includes("--offline");
  const json = process.argv.includes("--json");

  if (envFile) {
    if (!existsSync(envFile)) throw new Error(`No such file: ${envFile}`);
    // The file's settings, and only those, are what is checked: anything the
    // shell had under the same names is replaced.
    Object.assign(process.env, parse(readFileSync(envFile)));
  }
  const env = { ...process.env };

  // Imported after the settings are in place: some modules read them once.
  const { stagingConfigReport } = await import("../../lib/staging/config-check");
  const items: CheckItem[] = stagingConfigReport(env, role);
  if (!offline) {
    const { stagingLiveReport } = await import("../../lib/staging/live-check");
    items.push(...(await stagingLiveReport(env, role, { expected: argument("--expect-database") })));
  }

  const missing = items.filter((item) => item.state === "MISSING").length;
  const warnings = items.filter((item) => item.state === "WARNING").length;
  if (json) {
    process.stdout.write(`${JSON.stringify({ role, offline, missing, warnings, items }, null, 2)}\n`);
  } else {
    const width = Math.max(...items.map((item) => item.area.length));
    process.stdout.write(`Staging check — ${role}${offline ? " (settings only)" : ""}\n\n`);
    for (const item of items) process.stdout.write(`${item.state.padEnd(8)} ${item.area.padEnd(width)}  ${item.detail}\n`);
    process.stdout.write(`\n${missing} missing, ${warnings} warning(s), ${items.length - missing - warnings} ready.\n`);
  }
  process.exit(missing > 0 ? 1 : 0);
}

main().catch((error) => {
  // A message of our own, never a library's, which can quote an address.
  process.stderr.write(`Staging check failed: ${error instanceof Error && !/:\/\//.test(error.message) ? error.message : "unexpected error"}\n`);
  process.exit(1);
});
