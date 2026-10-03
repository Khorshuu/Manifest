/**
 * D-134: what keeps a hosted staging environment from reaching the wrong
 * database, the wrong media, or a pooler where a session lock is needed —
 * and the staging check that reports it without printing a value.
 *
 * Nothing here connects anywhere. The checks that connect run against the
 * real PostgreSQL server in `session-lock-concurrency.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { connectionMode, connectionOptions, declaredConnectionMode } from "@/db/connection";
import { databaseIdentityProblem, stagingDatabaseProblem } from "@/db/identity";
import { migrationFiles, migrationStatus, migrationChecksum } from "@/db/migrator";
import { localAiServiceGate } from "@/lib/jobs/worker";
import { getLocalServicesConfig, localRequest, localServiceUrl } from "@/lib/providers/local/config";
import { checkOllama, checkSearxng, clearLocalHealthCache } from "@/lib/providers/local/health";
import { slotConnectionProblem } from "@/lib/providers/local/slot";
import { BlobMediaProvider, blobPrefix } from "@/lib/providers/media/blob";
import { stagingConfigReport, type Environment } from "@/lib/staging/config-check";

const NEON_POOLED = "postgres://app:pooled-pass-1@ep-quiet-sea-123456-pooler.ap-southeast-1.aws.neon.tech/manifest_staging?sslmode=require";
const NEON_DIRECT = "postgres://app:direct-pass-2@ep-quiet-sea-123456.ap-southeast-1.aws.neon.tech/manifest_staging?sslmode=require";
const OTHER_PROVIDER = "postgres://app:other-pass-3@db.cloud-provider.example:6543/manifest_staging?sslmode=require";
const LOCAL = "postgres://postgres:postgres@127.0.0.1:5432/preorder_utf8";

describe("how a connection string reaches the server", () => {
  it("knows Neon's pooler by its host name, whatever is declared", () => {
    expect(connectionMode(NEON_POOLED)).toEqual({ mode: "transaction", source: "address" });
    expect(connectionMode(NEON_POOLED, "direct")).toEqual({ mode: "transaction", source: "address" });
  });

  it("does not take an ordinary-looking remote address to be direct", () => {
    expect(connectionMode(NEON_DIRECT)).toEqual({ mode: "unknown", source: "none" });
    expect(connectionMode(OTHER_PROVIDER)).toEqual({ mode: "unknown", source: "none" });
  });

  it("takes the operator's declaration for every other provider", () => {
    expect(connectionMode(OTHER_PROVIDER, "transaction")).toEqual({ mode: "transaction", source: "declared" });
    expect(connectionMode(OTHER_PROVIDER, "session")).toEqual({ mode: "session", source: "declared" });
    expect(declaredConnectionMode(" Session ")).toBe("session");
    expect(declaredConnectionMode("pooled")).toBeUndefined();
    expect(declaredConnectionMode(undefined)).toBeUndefined();
  });

  it("treats a database on this machine as direct", () => {
    expect(connectionMode(LOCAL)).toEqual({ mode: "direct", source: "loopback" });
  });

  it("turns prepared statements off behind a declared transaction pooler, as behind Neon's", () => {
    expect(connectionOptions(OTHER_PROVIDER, {}).prepare).toBe(true);
    expect(connectionOptions(OTHER_PROVIDER, { DATABASE_CONNECTION_MODE: "transaction" }).prepare).toBe(false);
    expect(connectionOptions(NEON_POOLED, {}).prepare).toBe(false);
  });

  it("refuses the local-AI slot behind a declared transaction pooler", () => {
    expect(slotConnectionProblem(OTHER_PROVIDER, "transaction")).toMatchObject({ code: "LOCAL_AI_SLOT_NEEDS_DIRECT_CONNECTION" });
    expect(slotConnectionProblem(OTHER_PROVIDER, "session")).toBeNull();
    expect(slotConnectionProblem(OTHER_PROVIDER, undefined)).toBeNull();
  });
});

describe("which database a deployment may touch", () => {
  it("refuses a database of another name when one is expected, and says nothing when none is", () => {
    expect(databaseIdentityProblem("manifest_staging", "manifest_staging")).toBeNull();
    expect(databaseIdentityProblem("neondb", undefined)).toBeNull();
    expect(databaseIdentityProblem("neondb", "manifest_staging")).toMatch(/Connected to database "neondb", but EXPECTED_DATABASE_NAME is "manifest_staging"/);
  });

  it("never accepts a development, test, scale or provider-default database as staging", () => {
    for (const name of ["preorder", "preorder_utf8", "preorder_e2e", "manifest_scale_1k", "manifest_scale_5k", "orders_test", "neondb", "postgres", "defaultdb"]) {
      expect(stagingDatabaseProblem(name), name).not.toBeNull();
    }
    expect(stagingDatabaseProblem("manifest_staging")).toBeNull();
    expect(stagingDatabaseProblem("manifest_staging_verify")).toBeNull();
  });
});

describe("the migration ledger, read without writing", () => {
  const files = migrationFiles();
  const executor = (rows: { name: string; checksum: string }[] | null) => ({
    async query<T>(statement: string): Promise<T[]> {
      if (statement.includes("to_regclass")) return [{ ledger: rows !== null }] as T[];
      return (rows ?? []) as T[];
    },
  });

  it("lists every migration as pending on a database with no ledger", async () => {
    const status = await migrationStatus(executor(null));
    expect(status).toMatchObject({ ledger: false, applied: 0, latest: null, changed: [], unknown: [] });
    expect(status.pending).toEqual(files);
  });

  it("names what is pending, what was edited since and what it does not know", async () => {
    const recorded = files.slice(0, -1).map((name) => ({ name, checksum: migrationChecksum(name) }));
    recorded[0] = { ...recorded[0], checksum: "edited" };
    recorded.push({ name: "9999_from_elsewhere.sql", checksum: "x" });
    const status = await migrationStatus(executor(recorded));
    expect(status.pending).toEqual([files.at(-1)]);
    expect(status.changed).toEqual([files[0]]);
    expect(status.unknown).toEqual(["9999_from_elsewhere.sql"]);
    expect(files.at(-1)! >= "0045").toBe(true);
  });
});

describe("the staging check's report", () => {
  const worker: Environment = {
    DATABASE_URL: NEON_DIRECT,
    DATABASE_CONNECTION_MODE: "direct",
    EXPECTED_DATABASE_NAME: "manifest_staging",
    SESSION_SECRET: "staging-session-secret-0123456789-abcdef",
    CRON_SECRET: "staging-cron-secret-0123456789abcdef",
    SITE_URL: "https://staging.shop.example",
    JOB_RUNNER: "worker",
    WORKER_ALIVE_FILE: "/tmp/alive",
    MEDIA_PROVIDER: "blob",
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_STOREID_supersecretblobtoken",
    MEDIA_BLOB_PREFIX: "staging/products",
    NOTIFICATION_PROVIDER: "smtp",
    SMTP_HOST: "smtp.mail-service.example",
    SMTP_PORT: "587",
    SMTP_USER: "apikey",
    SMTP_PASSWORD: "smtp-password-not-for-printing",
    EMAIL_FROM: "orders@shop.example",
    NOTIFICATION_RECIPIENT_ALLOWLIST: "tester@shop.example",
    PRODUCT_RESEARCH_PROVIDER: "local",
    SEARXNG_BASE_URL: "http://searxng:8080",
    SEARXNG_ALLOW_REMOTE: "true",
    PRODUCT_EXTRACTION_PROVIDER: "ollama",
    SEO_PULSE_AI_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "https://gpu-gateway.shop.example",
    OLLAMA_ALLOW_REMOTE: "true",
    OLLAMA_AUTH_TOKEN: "ollama-gateway-token-0123456789",
    OLLAMA_MODEL: "qwen2.5:7b",
    LOCAL_BROWSER_RENDERER: "playwright",
    SENTRY_DSN: "https://publickey@o0.ingest.sentry.example/1",
    PAYMENT_PROVIDER: "mock",
    SHIPPING_PROVIDER: "mock",
  };
  const web: Environment = {
    ...worker,
    DATABASE_URL: NEON_POOLED,
    DATABASE_URL_UNPOOLED: NEON_DIRECT,
    DATABASE_CONNECTION_MODE: undefined,
    OLLAMA_BASE_URL: undefined,
    SEARXNG_BASE_URL: undefined,
  };
  const state = (items: ReturnType<typeof stagingConfigReport>, area: string) => items.filter((item) => item.area === area).map((item) => item.state);

  it("finds nothing missing in a complete worker or web configuration", () => {
    expect(stagingConfigReport(worker, "worker").filter((item) => item.state === "MISSING")).toEqual([]);
    expect(stagingConfigReport(web, "web").filter((item) => item.state === "MISSING")).toEqual([]);
  });

  it("never prints a value: no address, password, token, recipient or key", () => {
    const text = JSON.stringify([stagingConfigReport(worker, "worker"), stagingConfigReport(web, "web")]);
    for (const secret of [
      "pooled-pass-1",
      "direct-pass-2",
      "ep-quiet-sea",
      "neon.tech",
      "staging-session-secret",
      "staging-cron-secret",
      "supersecretblobtoken",
      "smtp-password",
      "smtp.mail-service",
      "tester@shop.example",
      "gpu-gateway",
      "ollama-gateway-token",
      "publickey",
      "staging.shop.example",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("refuses a worker on a pooled address, and warns when the address's mode is not declared", () => {
    expect(state(stagingConfigReport({ ...worker, DATABASE_URL: NEON_POOLED }, "worker"), "Database (direct)")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, DATABASE_CONNECTION_MODE: undefined }, "worker"), "Database (direct)")).toEqual(["WARNING"]);
    expect(state(stagingConfigReport({ ...worker, DATABASE_CONNECTION_MODE: "transaction" }, "worker"), "Database (direct)")).toEqual(["MISSING"]);
  });

  it("needs the direct address on the web application, for migrations", () => {
    expect(state(stagingConfigReport({ ...web, DATABASE_URL_UNPOOLED: undefined }, "web"), "Database (direct)")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...web, DATABASE_URL_UNPOOLED: NEON_POOLED }, "web"), "Database (direct)")).toEqual(["MISSING"]);
  });

  it("refuses an address naming another database than the one expected, or a development one", () => {
    const elsewhere = NEON_DIRECT.replace("/manifest_staging", "/neondb");
    expect(state(stagingConfigReport({ ...worker, DATABASE_URL: elsewhere }, "worker"), "Database identity")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, EXPECTED_DATABASE_NAME: "preorder_utf8" }, "worker"), "Database identity")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, EXPECTED_DATABASE_NAME: undefined }, "worker"), "Database identity")).toEqual(["WARNING"]);
    expect(
      state(stagingConfigReport({ ...web, DATABASE_URL: NEON_POOLED.replace("/manifest_staging", "/neondb") }, "web"), "Database identity"),
    ).toContain("MISSING");
  });

  it("keeps staging off real money, real couriers and real customers' inboxes", () => {
    expect(state(stagingConfigReport({ ...worker, PAYMENT_PROVIDER: "sslcommerz" }, "worker"), "Payment")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, SHIPPING_PROVIDER: "pathao" }, "worker"), "Shipping")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, NOTIFICATION_RECIPIENT_ALLOWLIST: undefined }, "worker"), "Email allow-list")).toEqual(["MISSING"]);
  });

  it("needs the worker to run the jobs, real secrets, and a store the web application can keep files in", () => {
    expect(state(stagingConfigReport({ ...worker, JOB_RUNNER: undefined }, "worker"), "Job runner")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, CRON_SECRET: "change-me-to-a-long-random-string" }, "worker"), "Cron secret")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, SESSION_SECRET: "short" }, "worker"), "Session secret")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...web, MEDIA_PROVIDER: "local" }, "web"), "Media")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...web, MEDIA_BLOB_PREFIX: undefined }, "web"), "Media")).toEqual(["WARNING"]);
  });

  it("refuses a remote model or search address that was not explicitly allowed, or is public over plain http", () => {
    expect(state(stagingConfigReport({ ...worker, OLLAMA_ALLOW_REMOTE: undefined }, "worker"), "Ollama")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, OLLAMA_BASE_URL: "http://gpu.shop.example:11434" }, "worker"), "Ollama")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, SEARXNG_ALLOW_REMOTE: "false" }, "worker"), "SearXNG")).toEqual(["MISSING"]);
    expect(state(stagingConfigReport({ ...worker, LOCAL_AI_CONCURRENCY: "2" }, "worker"), "Ollama concurrency")).toEqual(["WARNING"]);
    const text = JSON.stringify(stagingConfigReport({ ...worker, OLLAMA_BASE_URL: "http://gpu.shop.example:11434" }, "worker"));
    expect(text).not.toContain("gpu.shop.example");
  });
});

describe("refusals that reach the health report", () => {
  it("never name the host they refused", async () => {
    const reasons = [localServiceUrl("http://gpu.shop.example:11434", false), localServiceUrl("http://gpu.shop.example:11434", true)];
    for (const reason of reasons) expect(JSON.stringify(reason)).not.toContain("gpu.shop.example");

    clearLocalHealthCache();
    const config = { ...getLocalServicesConfig(), OLLAMA_BASE_URL: "http://gpu.shop.example:11434", SEARXNG_BASE_URL: "http://search.shop.example:8080" };
    const ollama = await checkOllama("qwen2.5:7b", config);
    const searxng = await checkSearxng(config);
    expect(ollama.state).toBe("refused_address");
    expect(searxng.state).toBe("refused_address");
    expect(JSON.stringify([ollama, searxng])).not.toMatch(/shop\.example/);
  });
});

describe("the worker's view of the model's service", () => {
  const config = { ...getLocalServicesConfig(), OLLAMA_MODEL: "qwen2.5:7b", LOCAL_AI_SERVICE_WAIT_MINUTES: 30 };
  const probe = (state: string) => (async () => ({ state, model: "qwen2.5:7b", message: "" })) as unknown as typeof checkOllama;

  it("waits only for what can clear by itself", async () => {
    expect(await localAiServiceGate(config, probe("unavailable")).ready()).toBe(false);
    expect(await localAiServiceGate(config, probe("model_missing")).ready()).toBe(false);
    expect(await localAiServiceGate(config, probe("ready")).ready()).toBe(true);
    expect(await localAiServiceGate(config, probe("refused_address")).ready()).toBe(true);
    expect(await localAiServiceGate(config, probe("no_model")).ready()).toBe(true);
    expect(localAiServiceGate(config, probe("ready")).waitMs).toBe(30 * 60_000);
  });

  it("defaults to half an hour, and 0 turns waiting off", () => {
    vi.stubEnv("LOCAL_AI_SERVICE_WAIT_MINUTES", "");
    expect(getLocalServicesConfig().LOCAL_AI_SERVICE_WAIT_MINUTES).toBe(30);
    vi.stubEnv("LOCAL_AI_SERVICE_WAIT_MINUTES", "0");
    expect(getLocalServicesConfig().LOCAL_AI_SERVICE_WAIT_MINUTES).toBe(0);
    vi.unstubAllEnvs();
  });
});

describe("media kept apart between environments", () => {
  it("defaults to products/ and accepts a prefix of its own", () => {
    expect(blobPrefix(undefined)).toBe("products");
    expect(blobPrefix("/staging/products/")).toBe("staging/products");
    for (const bad of ["../products", "Staging", "a//b", "a b", "a_b"]) expect(() => blobPrefix(bad), bad).toThrow(/MEDIA_BLOB_PREFIX/);
  });

  it("never claims, reads or deletes another environment's files in a shared store", async () => {
    const staging = new BlobMediaProvider("token-not-used", "staging/products");
    const production = "https://abc123.public.blob.vercel-storage.com/products/0b0e7f3c.webp";
    expect(staging.keyFor(production)).toBeNull();
    expect(staging.keyFor("https://abc123.public.blob.vercel-storage.com/staging/products/0b0e7f3c.webp")).toBe("staging/products/0b0e7f3c.webp");
    expect(await staging.read("products/0b0e7f3c.webp")).toBeNull();
    // Refused before any request is made.
    await expect(staging.delete("products/0b0e7f3c.webp")).rejects.toThrow(/not valid/);
  });
});

describe("the worker container's health check", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-alive-"));
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/jobs/worker-alive.mjs"], { env: { ...process.env, WORKER_ALIVE_FILE: "", WORKER_ALIVE_MAX_AGE_SECONDS: "", WORKER_INTERVAL_SECONDS: "", ...env }, encoding: "utf8" });

  it("passes while the loop is turning, and fails when it stopped or never started", () => {
    const file = join(dir, "alive");
    writeFileSync(file, String(Date.now()));
    expect(run({ WORKER_ALIVE_FILE: file }).status).toBe(0);

    writeFileSync(file, String(Date.now() - 5 * 60_000));
    const stale = run({ WORKER_ALIVE_FILE: file });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/last ran \d+ s ago/);

    expect(run({ WORKER_ALIVE_FILE: join(dir, "never") }).status).toBe(1);
    expect(run({}).status).toBe(1);
  });
});

describe("a private service's connection that was reset before answering", () => {
  /** A service that drops the connection for its first `resets` requests, then answers. */
  async function resetting(resets: number) {
    let seen = 0;
    const server = http.createServer((request, response) => {
      seen += 1;
      if (seen <= resets) return request.socket.destroy();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`);
    return { url, seen: () => seen, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  it("is tried once more on a fresh connection, and answers", async () => {
    const service = await resetting(1);
    try {
      const result = await localRequest(service.url, { method: "POST", body: { model: "m" }, timeoutMs: 5_000, maxBytes: 1_000 });
      expect(result).toEqual({ ok: true, status: 200, text: '{"ok":true}' });
      expect(service.seen()).toBe(2);
    } finally {
      await service.close();
    }
  });

  it("is not retried again: a service that keeps dropping is unreachable after two tries", async () => {
    const service = await resetting(10);
    try {
      const result = await localRequest(service.url, { timeoutMs: 5_000, maxBytes: 1_000 });
      expect(result).toMatchObject({ ok: false, kind: "unreachable" });
      expect(service.seen()).toBe(2);
    } finally {
      await service.close();
    }
  });
});
