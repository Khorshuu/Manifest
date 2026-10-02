import { connectionMode, declaredConnectionMode } from "@/db/connection";
import { stagingDatabaseProblem } from "@/db/identity";
import { readEmailConfig } from "@/lib/providers/notification/config";
import { localServiceUrl } from "@/lib/providers/local/config";
import { blobPrefix } from "@/lib/providers/media/blob";

/**
 * Is this environment's configuration a staging deployment's (D-134)?
 *
 * Reads settings only — no connection, nothing written — and answers per
 * area with READY, WARNING (works, but not as staging should) or MISSING
 * (staging is not ready until it is fixed). `npm run staging:check` prints
 * it, then adds the live checks (lib/staging/live-check.ts).
 *
 * The web application and the worker are configured differently — above all
 * their database addresses — so the report is for one role at a time.
 *
 * Never a value: every detail is written from names, states and the parts of
 * an address that are not secret (whether it is a pooler's, the database's
 * name). No host, user, password, token, recipient or key.
 */

export type CheckState = "READY" | "WARNING" | "MISSING";
export type CheckItem = { area: string; state: CheckState; detail: string };
export type StagingRole = "web" | "worker";
export type Environment = Record<string, string | undefined>;

const value = (env: Environment, name: string) => env[name]?.trim() || undefined;
const flag = (env: Environment, name: string) => ["true", "1", "yes"].includes(value(env, name)?.toLowerCase() ?? "");

/** The database name in a connection string, which is not a secret. */
export function databaseNameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

function isPostgresUrl(url: string | undefined): url is string {
  return Boolean(url && /^postgres(ql)?:\/\//.test(url));
}

function databaseItems(env: Environment, role: StagingRole): CheckItem[] {
  const items: CheckItem[] = [];
  const url = value(env, "DATABASE_URL");
  const unpooled = value(env, "DATABASE_URL_UNPOOLED");
  const declaredRaw = value(env, "DATABASE_CONNECTION_MODE");
  const declared = declaredConnectionMode(declaredRaw);
  if (declaredRaw && !declared) {
    items.push({ area: "Database mode", state: "MISSING", detail: "DATABASE_CONNECTION_MODE must be direct, session or transaction." });
  }

  if (!isPostgresUrl(url)) {
    items.push({ area: role === "web" ? "Database (pooled)" : "Database (direct)", state: "MISSING", detail: "DATABASE_URL is not set to a postgres:// address." });
  } else {
    const mode = connectionMode(url, declared);
    if (role === "web") {
      items.push(
        mode.mode === "transaction"
          ? { area: "Database (pooled)", state: "READY", detail: `DATABASE_URL is a transaction pooler's address (${mode.source === "address" ? "Neon -pooler host" : "declared"}).` }
          : {
              area: "Database (pooled)",
              state: "WARNING",
              detail:
                "DATABASE_URL is not known to be pooled. Serverless functions need the pooled address; if this is one, set DATABASE_CONNECTION_MODE=transaction.",
            },
      );
    } else {
      items.push(
        mode.mode === "transaction"
          ? { area: "Database (direct)", state: "MISSING", detail: "The worker's DATABASE_URL is a transaction pooler's address; it needs the direct one (session advisory locks)." }
          : mode.mode === "unknown"
            ? {
                area: "Database (direct)",
                state: "WARNING",
                detail: "DATABASE_URL's mode is not declared. Set DATABASE_CONNECTION_MODE=direct (or session) once confirmed; the live check and the worker test it with a real lock.",
              }
            : { area: "Database (direct)", state: "READY", detail: `DATABASE_URL is ${mode.mode} (${mode.source}).` },
      );
    }
  }

  if (role === "web") {
    if (!isPostgresUrl(unpooled)) {
      items.push({ area: "Database (direct)", state: "MISSING", detail: "DATABASE_URL_UNPOOLED is not set: migrations at build time need the direct address." });
    } else if (connectionMode(unpooled).mode === "transaction") {
      items.push({ area: "Database (direct)", state: "MISSING", detail: "DATABASE_URL_UNPOOLED is a pooler's address; migrations need the direct one." });
    } else {
      items.push({ area: "Database (direct)", state: "READY", detail: "DATABASE_URL_UNPOOLED is set and not a pooler's address." });
    }
    const pooledName = databaseNameOf(url);
    const directName = databaseNameOf(unpooled);
    if (pooledName && directName && pooledName !== directName) {
      items.push({ area: "Database identity", state: "MISSING", detail: `DATABASE_URL names "${pooledName}" and DATABASE_URL_UNPOOLED names "${directName}"; both must be the same database.` });
    }
  }

  const expected = value(env, "EXPECTED_DATABASE_NAME");
  const named = databaseNameOf(role === "web" ? (unpooled ?? url) : url);
  if (!expected) {
    items.push({ area: "Database identity", state: "WARNING", detail: "EXPECTED_DATABASE_NAME is not set, so nothing stops a deployment migrating whichever database its address names." });
  } else {
    const problem = stagingDatabaseProblem(expected);
    if (problem) items.push({ area: "Database identity", state: "MISSING", detail: `EXPECTED_DATABASE_NAME: ${problem}` });
    else if (named && named !== expected) {
      items.push({ area: "Database identity", state: "MISSING", detail: `The address names "${named}", but EXPECTED_DATABASE_NAME is "${expected}".` });
    } else {
      items.push({ area: "Database identity", state: "READY", detail: `Pinned to "${expected}"; confirmed against current_database() by the live check, the migration and the worker.` });
    }
  }
  return items;
}

function secretItems(env: Environment, role: StagingRole): CheckItem[] {
  const items: CheckItem[] = [];
  const session = value(env, "SESSION_SECRET");
  items.push(
    session && session.length >= 32
      ? { area: "Session secret", state: "READY", detail: "SESSION_SECRET is set (32+ characters)." }
      : { area: "Session secret", state: "MISSING", detail: "SESSION_SECRET must be 32+ characters, and different from every other environment's." },
  );
  const cron = value(env, "CRON_SECRET");
  items.push(
    cron && cron.length >= 24 && !/change-me/i.test(cron)
      ? { area: "Cron secret", state: "READY", detail: "CRON_SECRET is set." }
      : { area: "Cron secret", state: "MISSING", detail: "CRON_SECRET must be a long random value (24+ characters), not the example's." },
  );
  const site = value(env, role === "worker" ? "WORKER_WEB_URL" : "SITE_URL") ?? value(env, "SITE_URL");
  if (!site) {
    items.push({
      area: "Site address",
      state: "WARNING",
      detail: role === "worker" ? "Neither WORKER_WEB_URL nor SITE_URL is set: pages the worker changes refresh only when their cache lapses." : "SITE_URL is not set: canonical links use the deployment's own address.",
    });
  } else {
    items.push(
      site.startsWith("https://")
        ? { area: "Site address", state: "READY", detail: "Set, over https." }
        : { area: "Site address", state: "WARNING", detail: "Set, but not https." },
    );
  }
  return items;
}

function workerItems(env: Environment, role: StagingRole): CheckItem[] {
  const runner = value(env, "JOB_RUNNER")?.toLowerCase();
  const items: CheckItem[] = [
    runner === "worker"
      ? { area: "Job runner", state: "READY", detail: "JOB_RUNNER=worker: the worker runs the queue; /api/cron/jobs declines." }
      : { area: "Job runner", state: "MISSING", detail: "JOB_RUNNER must be worker on the web application and the worker alike." },
  ];
  if (role === "worker") {
    items.push(
      value(env, "WORKER_ALIVE_FILE")
        ? { area: "Worker liveness", state: "READY", detail: "WORKER_ALIVE_FILE is set for the container health check." }
        : { area: "Worker liveness", state: "WARNING", detail: "WORKER_ALIVE_FILE is not set, so a container health check has nothing to read (deploy/worker.Dockerfile sets it)." },
    );
  }
  return items;
}

function mediaItems(env: Environment, role: StagingRole): CheckItem[] {
  const provider = value(env, "MEDIA_PROVIDER") ?? (value(env, "BLOB_READ_WRITE_TOKEN") ? "blob" : "local");
  if (provider !== "blob") {
    return [
      role === "web"
        ? { area: "Media", state: "MISSING", detail: "MEDIA_PROVIDER is local: a serverless host keeps no files. Link a staging Blob store." }
        : { area: "Media", state: "WARNING", detail: "MEDIA_PROVIDER is not blob: the worker's media sweep would look at the wrong store." },
    ];
  }
  if (!value(env, "BLOB_READ_WRITE_TOKEN")) {
    return [{ area: "Media", state: "MISSING", detail: "MEDIA_PROVIDER=blob without BLOB_READ_WRITE_TOKEN." }];
  }
  let prefix: string;
  try {
    prefix = blobPrefix(value(env, "MEDIA_BLOB_PREFIX"));
  } catch (error) {
    return [{ area: "Media", state: "MISSING", detail: (error as Error).message }];
  }
  return [
    prefix === "products"
      ? {
          area: "Media",
          state: "WARNING",
          detail: "Blob store set, default prefix. Use a staging store of its own; if the store is shared with production, set MEDIA_BLOB_PREFIX=staging/products.",
        }
      : { area: "Media", state: "READY", detail: `Blob store set, uploads under "${prefix}/".` },
  ];
}

function emailItems(env: Environment): CheckItem[] {
  const provider = value(env, "NOTIFICATION_PROVIDER") ?? "mock";
  if (provider !== "smtp") {
    return [{ area: "Email", state: "WARNING", detail: `NOTIFICATION_PROVIDER is ${provider}: messages are recorded and sent nowhere.` }];
  }
  const read = readEmailConfig(env);
  const items: CheckItem[] = [
    read.ok
      ? { area: "Email", state: "READY", detail: `SMTP configured (port ${read.config.SMTP_PORT}, TLS required).` }
      : { area: "Email", state: "MISSING", detail: `SMTP settings: ${read.problems.join("; ")}.` },
  ];
  items.push(
    value(env, "NOTIFICATION_RECIPIENT_ALLOWLIST")
      ? { area: "Email allow-list", state: "READY", detail: "NOTIFICATION_RECIPIENT_ALLOWLIST is set: only listed recipients are written to." }
      : { area: "Email allow-list", state: "MISSING", detail: "Staging must set NOTIFICATION_RECIPIENT_ALLOWLIST, so a test order cannot email a real customer." },
  );
  return items;
}

function researchItems(env: Environment, role: StagingRole): CheckItem[] {
  const items: CheckItem[] = [];
  const research = value(env, "PRODUCT_RESEARCH_PROVIDER") ?? "none";
  const extraction = value(env, "PRODUCT_EXTRACTION_PROVIDER") ?? "none";
  const seo = value(env, "SEO_PULSE_AI_PROVIDER") ?? "rules";
  const localAi = extraction === "ollama" || seo === "ollama";

  if (role === "web") {
    // The web application never calls these; it only needs the provider names to queue work.
    if (value(env, "OLLAMA_BASE_URL") || value(env, "SEARXNG_BASE_URL")) {
      items.push({ area: "Private services", state: "WARNING", detail: "OLLAMA_BASE_URL or SEARXNG_BASE_URL is set on the web application, which never calls them; leave them to the worker." });
    }
    return items;
  }

  if (research === "local") {
    const base = value(env, "SEARXNG_BASE_URL");
    if (!base) items.push({ area: "SearXNG", state: "WARNING", detail: "PRODUCT_RESEARCH_PROVIDER=local without SEARXNG_BASE_URL: sitemaps and the registry only." });
    else {
      const address = localServiceUrl(base, flag(env, "SEARXNG_ALLOW_REMOTE"));
      items.push(
        address.ok
          ? { area: "SearXNG", state: "READY", detail: address.remote ? "Remote, private or https, explicitly allowed." : "On this machine." }
          : { area: "SearXNG", state: "MISSING", detail: `SEARXNG_BASE_URL is refused: ${address.reason}.` },
      );
    }
  } else {
    items.push({ area: "SearXNG", state: "WARNING", detail: `PRODUCT_RESEARCH_PROVIDER is ${research}: no web search for research.` });
  }

  if (localAi) {
    const base = value(env, "OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434";
    const address = localServiceUrl(base, flag(env, "OLLAMA_ALLOW_REMOTE"));
    const model = value(env, "OLLAMA_SEO_MODEL") ?? value(env, "OLLAMA_EXTRACTION_MODEL") ?? value(env, "OLLAMA_MODEL");
    if (!address.ok) items.push({ area: "Ollama", state: "MISSING", detail: `OLLAMA_BASE_URL is refused: ${address.reason}.` });
    else if (!model) items.push({ area: "Ollama", state: "MISSING", detail: "No model chosen: set OLLAMA_MODEL (qwen2.5:7b)." });
    else items.push({ area: "Ollama", state: "READY", detail: `${address.remote ? "Remote, private or https, explicitly allowed" : "On this machine"}; model ${model}.` });
    const concurrency = value(env, "LOCAL_AI_CONCURRENCY") ?? "1";
    if (concurrency !== "1") {
      items.push({ area: "Ollama concurrency", state: "WARNING", detail: `LOCAL_AI_CONCURRENCY is ${concurrency}; keep 1 until the GPU has been benchmarked with two generations at once.` });
    }
  } else {
    items.push({ area: "Ollama", state: "WARNING", detail: "No local AI configured: SeoPulse writes with the rules generator and pages are read by the structured readers only." });
  }

  const renderer = value(env, "LOCAL_BROWSER_RENDERER") ?? "none";
  items.push(
    renderer === "playwright"
      ? { area: "Browser renderer", state: "READY", detail: "LOCAL_BROWSER_RENDERER=playwright." }
      : { area: "Browser renderer", state: "WARNING", detail: "LOCAL_BROWSER_RENDERER is none: pages that need JavaScript are read as their static copy." },
  );
  return items;
}

function optionalItems(env: Environment): CheckItem[] {
  const items: CheckItem[] = [];
  const console = value(env, "SEARCH_CONSOLE_PROVIDER") ?? "none";
  if (console === "google") {
    const credentials = value(env, "GOOGLE_SEARCH_CONSOLE_CREDENTIALS") || (value(env, "GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL") && value(env, "GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY"));
    items.push(
      value(env, "SEARCH_CONSOLE_SITE_URL") && credentials
        ? { area: "Search Console", state: "READY", detail: "Property and service-account credentials set." }
        : { area: "Search Console", state: "MISSING", detail: "SEARCH_CONSOLE_PROVIDER=google needs SEARCH_CONSOLE_SITE_URL and service-account credentials." },
    );
  } else {
    items.push({ area: "Search Console", state: "WARNING", detail: "Not connected (optional): reported as not connected, nothing estimated." });
  }
  items.push(
    value(env, "SENTRY_DSN")
      ? { area: "Error tracking", state: "READY", detail: "SENTRY_DSN is set." }
      : { area: "Error tracking", state: "WARNING", detail: "SENTRY_DSN is not set (optional): errors are in the logs only." },
  );
  return items;
}

function mockItems(env: Environment): CheckItem[] {
  return (["PAYMENT_PROVIDER", "SHIPPING_PROVIDER"] as const).map((name) => {
    const provider = value(env, name) ?? "mock";
    const area = name === "PAYMENT_PROVIDER" ? "Payment" : "Shipping";
    return provider === "mock"
      ? { area, state: "READY" as const, detail: `${name}=mock: ${area === "Payment" ? "no money moves" : "nothing is booked"}.` }
      : { area, state: "MISSING" as const, detail: `${name} is ${provider}; staging stays on the mock.` };
  });
}

export function stagingConfigReport(env: Environment, role: StagingRole): CheckItem[] {
  return [
    ...databaseItems(env, role),
    ...secretItems(env, role),
    ...workerItems(env, role),
    ...mediaItems(env, role),
    ...emailItems(env),
    ...researchItems(env, role),
    ...optionalItems(env),
    ...mockItems(env),
  ];
}
