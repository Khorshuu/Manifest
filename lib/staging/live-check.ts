import postgres from "postgres";
import { connectionMode, declaredConnectionMode } from "@/db/connection";
import { databaseIdentityProblem, stagingDatabaseProblem } from "@/db/identity";
import { migrationStatus, postgresExecutor } from "@/db/migrator";
import { probeSessionLock } from "@/db/session-probe";
import { getLocalServicesConfig, ollamaModelFor } from "@/lib/providers/local/config";
import { checkOllama, checkSearxng } from "@/lib/providers/local/health";
import { SmtpNotificationProvider } from "@/lib/providers/notification/smtp";
import type { CheckItem, Environment, StagingRole } from "./config-check";

/**
 * The checks `npm run staging:check` makes against the services themselves
 * (D-134). Read only: a `select`, a session lock taken and released on a key
 * nobody else uses, an SMTP login with nothing sent, one SearXNG query and
 * Ollama's list of models. Nothing is migrated, written, uploaded or sent.
 *
 * Every connection is bounded and closed; every failure is reported by kind,
 * never by the server's own text, which can carry a host or a user name.
 */

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type Row = Record<string, unknown>;

function isRemote(url: string): boolean {
  try {
    return !LOCAL.has(new URL(url).hostname.toLowerCase());
  } catch {
    return true;
  }
}

/** Whether the address makes the client refuse a connection without TLS. */
export function tlsRequiredByAddress(url: string): boolean {
  try {
    const mode = new URL(url).searchParams.get("sslmode")?.toLowerCase();
    return mode === "require" || mode === "verify-ca" || mode === "verify-full";
  } catch {
    return false;
  }
}

function failureKind(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (code === "28P01" || code === "28000") return "the login was refused";
  if (code === "3D000") return "the database does not exist";
  if (code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "the server did not answer in time";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return "the server could not be reached";
  return "the connection failed";
}

/**
 * One database address: which database it reaches, over what, at which
 * migration, and — where session locks matter — whether one holds.
 */
export async function checkDatabaseLive(
  label: string,
  url: string,
  options: { expected?: string; staging: boolean; sessionLocks: boolean; declared?: ReturnType<typeof declaredConnectionMode> },
): Promise<{ items: CheckItem[]; database: string | null }> {
  const items: CheckItem[] = [];
  const mode = connectionMode(url, options.declared);
  const client = postgres(url, { max: 2, connect_timeout: 10, prepare: false, idle_timeout: 5, onnotice: () => {} });
  try {
    let row: Row;
    try {
      [row] = (await client`
        select current_database() as name,
               current_schema() as schema,
               current_setting('server_version') as version,
               (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl
      `) as Row[];
    } catch (error) {
      items.push({ area: `${label}: connection`, state: "MISSING", detail: `Could not connect: ${failureKind(error)}.` });
      return { items, database: null };
    }
    const name = String(row.name);
    items.push({ area: `${label}: connection`, state: "READY", detail: `Connected to "${name}", PostgreSQL ${String(row.version).split(" ")[0]}, schema ${String(row.schema)}.` });

    const identity = databaseIdentityProblem(name, options.expected);
    const notStaging = options.staging ? stagingDatabaseProblem(name) : null;
    if (identity || notStaging) items.push({ area: `${label}: identity`, state: "MISSING", detail: (identity ?? notStaging) as string });
    else if (!options.expected) items.push({ area: `${label}: identity`, state: "WARNING", detail: `Reached "${name}"; set EXPECTED_DATABASE_NAME to pin it.` });
    else items.push({ area: `${label}: identity`, state: "READY", detail: `current_database() is "${name}", as expected.` });

    const remote = isRemote(url);
    // A provider's proxy (Neon's) ends TLS in front of the server, so the
    // server can report its own connection as unencrypted while the one from
    // here is. sslmode=require (or verify-*) makes the client refuse to
    // connect without TLS, so a connection that exists is encrypted.
    const tlsRequired = tlsRequiredByAddress(url);
    items.push(
      row.ssl === true
        ? { area: `${label}: TLS`, state: "READY", detail: "The connection is encrypted." }
        : tlsRequired
          ? { area: `${label}: TLS`, state: "READY", detail: "Encrypted to the provider: the address requires TLS (the server sits behind a TLS-ending proxy)." }
          : remote
            ? { area: `${label}: TLS`, state: "MISSING", detail: "A remote database reached without TLS. Add sslmode=require to the address." }
            : { area: `${label}: TLS`, state: "READY", detail: "Not encrypted; acceptable only because the server is on this machine." },
    );

    const status = await migrationStatus(postgresExecutor(client));
    if (!status.ledger) {
      items.push({ area: `${label}: migrations`, state: "MISSING", detail: `No migration ledger: ${status.pending.length} migrations to apply (npm run db:migrate:deploy).` });
    } else if (status.changed.length > 0) {
      items.push({ area: `${label}: migrations`, state: "MISSING", detail: `Applied migrations were edited since: ${status.changed.join(", ")}. Migrating will stop.` });
    } else if (status.pending.length > 0) {
      items.push({ area: `${label}: migrations`, state: "WARNING", detail: `${status.applied} applied, ${status.pending.length} pending (first: ${status.pending[0]}). The next deployment applies them.` });
    } else {
      items.push({ area: `${label}: migrations`, state: "READY", detail: `Up to date: ${status.applied} applied, latest ${status.latest}.` });
    }

    if (options.sessionLocks) {
      if (mode.mode === "transaction") {
        items.push({ area: `${label}: session lock`, state: "MISSING", detail: "A transaction pooler's address: session advisory locks do not hold here." });
      } else {
        const probe = await probeSessionLock(client);
        items.push({
          area: `${label}: session lock`,
          state: probe.verdict === "session" ? (mode.mode === "unknown" ? "WARNING" : "READY") : "MISSING",
          detail:
            probe.verdict === "session" && mode.mode === "unknown"
              ? `${probe.detail} A pooler under no load can pass this too: set DATABASE_CONNECTION_MODE once the provider confirms the address is direct.`
              : probe.detail,
        });
      }
    }
    return { items, database: name };
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export async function stagingLiveReport(env: Environment, role: StagingRole, options: { expected?: string } = {}): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  const expected = options.expected ?? env.EXPECTED_DATABASE_NAME?.trim() ?? undefined;
  const declared = declaredConnectionMode(env.DATABASE_CONNECTION_MODE);
  const url = env.DATABASE_URL?.trim();
  const unpooled = env.DATABASE_URL_UNPOOLED?.trim();

  if (role === "web") {
    const pooled = url ? await checkDatabaseLive("Pooled address", url, { expected, staging: true, sessionLocks: false, declared }) : null;
    const direct = unpooled ? await checkDatabaseLive("Direct address", unpooled, { expected, staging: true, sessionLocks: true }) : null;
    items.push(...(pooled?.items ?? []), ...(direct?.items ?? []));
    if (pooled?.database && direct?.database && pooled.database !== direct.database) {
      items.push({ area: "Database identity", state: "MISSING", detail: `The pooled address reaches "${pooled.database}" and the direct one "${direct.database}".` });
    }
  } else if (url) {
    // The session lock is tested whether or not local AI is on now: it is
    // what the slot needs the day it is switched on.
    items.push(...(await checkDatabaseLive("Worker database", url, { expected, staging: true, sessionLocks: true, declared })).items);
  }

  if (env.NOTIFICATION_PROVIDER?.trim() === "smtp") {
    // Logs in and says goodbye; sends nothing.
    const health = await new SmtpNotificationProvider(env).health();
    items.push({ area: "Email: SMTP login", state: health.state === "ready" ? "READY" : "MISSING", detail: health.message });
  }

  if (role === "worker") {
    const config = getLocalServicesConfig();
    if (env.PRODUCT_RESEARCH_PROVIDER?.trim() === "local" && config.SEARXNG_BASE_URL) {
      const searxng = await checkSearxng(config);
      items.push({ area: "SearXNG: search", state: searxng.state === "ready" ? "READY" : "MISSING", detail: searxng.message });
    }
    const localAi = env.PRODUCT_EXTRACTION_PROVIDER?.trim() === "ollama" || env.SEO_PULSE_AI_PROVIDER?.trim() === "ollama";
    if (localAi) {
      const model = ollamaModelFor(config, "seo") ?? ollamaModelFor(config, "extraction");
      const ollama = await checkOllama(model, config);
      items.push({ area: "Ollama: model", state: ollama.state === "ready" ? "READY" : "MISSING", detail: ollama.message });
    }
  }
  return items;
}
