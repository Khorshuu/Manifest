/**
 * Error tracking (Sentry), without a Sentry account: the SDK is pointed at a
 * local HTTP server standing in for Sentry's ingest, so what would actually
 * leave the server is captured and inspected. A real project and DSN are still
 * needed to verify delivery to Sentry itself.
 */
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import type { ErrorEvent } from "@sentry/nextjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scrubBreadcrumb, scrubEvent, sentryOptions } from "@/lib/observability/error-reporting";
import { logEvent } from "@/lib/observability/log";

describe("scrubbing an event before it is sent", () => {
  it("drops cookies, bodies, query strings, the user and unlisted headers", () => {
    const event = scrubEvent({
      type: undefined,
      user: { email: "rahim@example.com", ip_address: "203.0.113.9" },
      server_name: "ip-10-0-0-1",
      request: {
        method: "POST",
        url: "https://shop.example/orders/lookup?email=rahim@example.com",
        cookies: { manifest_session: "abc" },
        data: { password: "hunter2" },
        query_string: "email=rahim@example.com",
        headers: { cookie: "manifest_session=abc", authorization: "Bearer x", "user-agent": "UA", "x-request-id": "r-1" },
      },
    } as ErrorEvent);

    expect(event.user).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(event.request).toEqual({
      method: "POST",
      url: "https://shop.example/orders/lookup",
      headers: { "user-agent": "UA", "x-request-id": "r-1" },
    });
  });

  it("masks emails and phone numbers in messages and redacts sensitive extras", () => {
    const event = scrubEvent({
      type: undefined,
      message: "No account for rahim@example.com",
      exception: { values: [{ type: "Error", value: "SMS to +8801711223344 failed" }] },
      extra: { token: "secret-token", orderNumber: "ORD-2026-000015" },
      breadcrumbs: [{ message: "lookup rahim@example.com", data: { url: "/api/x?email=a@b.co", cookie: "c" } }],
    } as ErrorEvent);

    expect(event.message).toBe("No account for r***@example.com");
    expect(event.exception?.values?.[0].value).toBe("SMS to ***344 failed");
    expect(event.extra).toEqual({ token: "[redacted]", orderNumber: "ORD-2026-000015" });
    expect(event.breadcrumbs?.[0]).toMatchObject({
      message: "lookup r***@example.com",
      data: { url: "/api/x", cookie: "[redacted]" },
    });
  });

  it("scrubs a breadcrumb on its own the same way", () => {
    expect(scrubBreadcrumb({ message: "call 01711223344", data: { secret: "s" } })).toMatchObject({
      message: "call ***344",
      data: { secret: "[redacted]" },
    });
  });
});

describe("configuration", () => {
  it("does not send personal data, local variables or traces by default", () => {
    vi.stubEnv("SENTRY_DSN", "http://public@127.0.0.1:1/1");
    vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "");
    const options = sentryOptions();
    expect(options.sendDefaultPii).toBe(false);
    expect(options.includeLocalVariables).toBe(false);
    expect("tracesSampleRate" in options).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("delivery to an ingest endpoint", () => {
  let server: Server;
  const envelopes: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const text = request.headers["content-encoding"] === "gzip" ? gunzipSync(body).toString() : body.toString();
        envelopes.push(text);
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    vi.stubEnv("SENTRY_DSN", `http://publickey@127.0.0.1:${port}/1`);
    vi.stubEnv("SENTRY_ENVIRONMENT", "test");
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({ ...sentryOptions(), defaultIntegrations: false });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
  });

  it("sends an error-level log event, redacted, and nothing for warnings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await logEvent("warn", "rate_limit.prune_failed", { error: new Error("not sent") });
    await logEvent("error", "payments.start_failed", {
      orderNumber: "ORD-2026-000042",
      email: "rahim@example.com",
      authorization: "Bearer abc",
      error: new Error("Provider refused rahim@example.com"),
    });

    expect(envelopes).toHaveLength(1);
    const sent = envelopes[0];
    expect(sent).toContain("payments.start_failed");
    expect(sent).toContain("ORD-2026-000042");
    expect(sent).toContain("r***@example.com");
    expect(sent).not.toContain("rahim@example.com");
    expect(sent).not.toContain("Bearer abc");
    expect(sent).not.toContain("not sent");
    expect(sent).toContain('"environment":"test"');
  });
});
