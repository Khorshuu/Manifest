/**
 * The Google Search Console provider, against the published contract
 * (risk R-15).
 *
 * **This does not verify the integration.** No Google credentials exist, so
 * nothing here has ever spoken to Google, and the suite is careful not to
 * pretend otherwise: it stubs `fetch` and checks the half of the contract this
 * shop is responsible for — the request it sends, and what it does with each
 * kind of answer. A mismatch in Google's half would still only show up on the
 * first real connection, and the design's answer to that is that a response it
 * cannot read becomes a reported provider failure rather than a stored number.
 *
 * The bodies below are shaped like the Search Analytics API's documented
 * responses. They are fixtures written from the documentation, not captures.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSearchConsoleProvider } from "@/lib/providers/search-console/google";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CLIENT_EMAIL = "manifest-reader@example-project.iam.gserviceaccount.com";
const PROPERTY = "sc-domain:manifest.example";

const saved: Record<string, string | undefined> = {};
const KEYS = [
  "SEARCH_CONSOLE_SITE_URL",
  "GOOGLE_SEARCH_CONSOLE_CREDENTIALS",
  "GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL",
  "GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY",
];

function configure(values: Record<string, string | undefined>) {
  for (const key of KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

/** The whole service-account JSON, as the host variable holds it. */
function credentialsJson(key = privateKey) {
  return JSON.stringify({
    type: "service_account",
    project_id: "example-project",
    client_email: CLIENT_EMAIL,
    private_key: key,
  });
}

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

/** Answers the token endpoint, then hands each API call to `answer`. */
function stubFetch(answer: (call: Call, index: number) => Response | Promise<Response>) {
  let apiCalls = 0;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init: RequestInit = {}) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init });
    if (href.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "token-value", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return answer({ url: href, init }, apiCalls++);
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const request = {
  property: PROPERTY,
  startDate: "2026-09-01",
  endDate: "2026-09-07",
  dimension: "page" as const,
  rowLimit: 3,
  startRow: 0,
};

beforeEach(() => {
  calls = [];
  for (const key of KEYS) saved[key] = process.env[key];
  configure({ SEARCH_CONSOLE_SITE_URL: PROPERTY, GOOGLE_SEARCH_CONSOLE_CREDENTIALS: credentialsJson() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  configure(saved);
});

describe("what the provider sends", () => {
  it("asks for settled web figures over the window, for the dimension it was given", async () => {
    stubFetch(() => json({ rows: [] }));
    await new GoogleSearchConsoleProvider().fetchPerformance(request);

    const api = calls.find((call) => call.url.includes("searchconsole.googleapis.com"))!;
    expect(api.url).toBe(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(PROPERTY)}/searchAnalytics/query`,
    );
    expect(api.init.method).toBe("POST");

    const body = JSON.parse(String(api.init.body));
    expect(body).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      rowLimit: 3,
      startRow: 0,
      type: "web",
      // Search Console revises its most recent days. Storing a provisional
      // number as final is how a "decline" gets reported for a day that had
      // not finished being counted.
      dataState: "final",
    });
    expect(body.dimensions).toEqual(["date", "page"]);
  });

  it("sends the access token and never the key that bought it", async () => {
    stubFetch(() => json({ rows: [] }));
    await new GoogleSearchConsoleProvider().fetchPerformance(request);

    const api = calls.find((call) => call.url.includes("searchconsole.googleapis.com"))!;
    expect((api.init.headers as Record<string, string>).authorization).toBe("Bearer token-value");
    expect(String(api.init.body)).not.toContain("PRIVATE KEY");
  });

  it("buys one token and re-uses it for the next window", async () => {
    stubFetch(() => json({ rows: [] }));
    const provider = new GoogleSearchConsoleProvider();
    await provider.fetchPerformance(request);
    await provider.fetchPerformance({ ...request, startRow: 3 });

    expect(calls.filter((call) => call.url.includes("oauth2.googleapis.com"))).toHaveLength(1);
  });
});

describe("what the provider does with an answer", () => {
  it("reads a documented response into rows", async () => {
    stubFetch(() =>
      json({
        rows: [
          { keys: ["2026-09-01", "https://manifest.example/products/kettle"], clicks: 4, impressions: 120, ctr: 0.0333, position: 8.4 },
          { keys: ["2026-09-02", "https://manifest.example/products/kettle"], clicks: 0, impressions: 90, ctr: 0, position: 11.2 },
        ],
      }),
    );

    const result = await new GoogleSearchConsoleProvider().fetchPerformance(request);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.rows).toEqual([
      { date: "2026-09-01", page: "https://manifest.example/products/kettle", query: null, clicks: 4, impressions: 120, ctr: 0.0333, position: 8.4 },
      { date: "2026-09-02", page: "https://manifest.example/products/kettle", query: null, clicks: 0, impressions: 90, ctr: 0, position: 11.2 },
    ]);
  });

  it("puts each dimension's key where that dimension asked for it", async () => {
    stubFetch(() =>
      json({
        rows: [
          { keys: ["2026-09-01", "https://manifest.example/products/kettle", "travel kettle"], clicks: 2, impressions: 40, ctr: 0.05, position: 6 },
        ],
      }),
    );

    const result = await new GoogleSearchConsoleProvider().fetchPerformance({ ...request, dimension: "page_query" });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.rows[0]).toMatchObject({
      date: "2026-09-01",
      page: "https://manifest.example/products/kettle",
      query: "travel kettle",
    });
  });

  it("treats an absent measurement as zero and a fractional count as a count", async () => {
    stubFetch(() => json({ rows: [{ keys: ["2026-09-01", "/a"], impressions: 10.6 }] }));

    const result = await new GoogleSearchConsoleProvider().fetchPerformance(request);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.rows[0]).toMatchObject({ clicks: 0, impressions: 11, ctr: 0, position: 0 });
  });

  it("drops a row with no date rather than storing it against nothing", async () => {
    stubFetch(() => json({ rows: [{ keys: [], clicks: 9 }, { keys: ["2026-09-01", "/a"], clicks: 1 }] }));

    const result = await new GoogleSearchConsoleProvider().fetchPerformance(request);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.rows).toHaveLength(1);
  });

  it("reads a window with no data as no rows, not as a failure", async () => {
    stubFetch(() => json({}));
    const empty = await new GoogleSearchConsoleProvider().fetchPerformance(request);
    expect(empty).toMatchObject({ status: "OK", rows: [], hasMore: false });

    stubFetch(() => json({ rows: null }));
    const nulled = await new GoogleSearchConsoleProvider().fetchPerformance(request);
    expect(nulled).toMatchObject({ status: "OK", rows: [] });
  });

  it("says there may be more only when the page came back full", async () => {
    stubFetch(() =>
      json({ rows: [1, 2, 3].map((n) => ({ keys: [`2026-09-0${n}`, "/a"], clicks: n })) }),
    );
    expect(await new GoogleSearchConsoleProvider().fetchPerformance(request)).toMatchObject({ hasMore: true });

    stubFetch(() => json({ rows: [{ keys: ["2026-09-01", "/a"], clicks: 1 }] }));
    expect(await new GoogleSearchConsoleProvider().fetchPerformance(request)).toMatchObject({ hasMore: false });
  });
});

describe("what the provider does with a refusal", () => {
  it("separates a temporary refusal from a permanent one", async () => {
    // Retry later, and do not move the watermark.
    for (const status of [401, 403, 429, 500, 503]) {
      stubFetch(() => json({ error: { message: "nope" } }, status));
      const result = await new GoogleSearchConsoleProvider().fetchPerformance(request);
      expect(result.status).toBe("UNAVAILABLE");
    }
    // A request this shop got wrong. Retrying it unchanged will not help.
    stubFetch(() => json({ error: { message: "bad request" } }, 400));
    expect(await new GoogleSearchConsoleProvider().fetchPerformance(request)).toMatchObject({ status: "FAILED" });
  });

  it("reports an unreadable answer rather than storing a number from it", async () => {
    stubFetch(() => new Response("<html>service unavailable</html>", { status: 200 }));
    expect(await new GoogleSearchConsoleProvider().fetchPerformance(request)).toMatchObject({ status: "FAILED" });

    stubFetch(() => json({ rows: "not an array" }));
    expect(await new GoogleSearchConsoleProvider().fetchPerformance(request)).toMatchObject({ status: "FAILED" });
  });

  it("reports a network failure as unavailable, with the reason", async () => {
    stubFetch(() => {
      throw new Error("ETIMEDOUT");
    });
    const result = await new GoogleSearchConsoleProvider().fetchPerformance(request);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.status === "UNAVAILABLE" && result.message).toContain("ETIMEDOUT");
  });

  it("never quotes a credential in any message it returns", async () => {
    configure({
      SEARCH_CONSOLE_SITE_URL: PROPERTY,
      GOOGLE_SEARCH_CONSOLE_CREDENTIALS: credentialsJson("-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----"),
    });
    stubFetch(() => json({ rows: [] }));

    const result = await new GoogleSearchConsoleProvider().fetchPerformance(request);
    expect(result.status).toBe("UNAVAILABLE");
    const message = result.status === "UNAVAILABLE" ? result.message : "";
    expect(message).not.toContain("not-a-key");
    expect(message).not.toContain("PRIVATE KEY");
    // And it says something an operator can act on.
    expect(message).toMatch(/private key could not be read/i);
  });
});

describe("configuration", () => {
  it("accepts the key as two fields as well as one JSON blob", () => {
    configure({
      SEARCH_CONSOLE_SITE_URL: PROPERTY,
      GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL: CLIENT_EMAIL,
      GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY: privateKey,
    });
    expect(new GoogleSearchConsoleProvider().connection()).toEqual({
      status: "CONFIGURED",
      property: PROPERTY,
      account: CLIENT_EMAIL,
    });
  });

  it("restores the newlines a host variable escapes", async () => {
    configure({
      SEARCH_CONSOLE_SITE_URL: PROPERTY,
      GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL: CLIENT_EMAIL,
      // What pasting a key into a dashboard usually produces.
      GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
    });
    stubFetch(() => json({ rows: [] }));

    // It reached the API, which means the escaped key signed a token.
    expect(await new GoogleSearchConsoleProvider().fetchPerformance(request)).toMatchObject({ status: "OK" });
  });

  it("says which piece is missing, and names no value", () => {
    configure({ GOOGLE_SEARCH_CONSOLE_CREDENTIALS: credentialsJson() });
    expect(new GoogleSearchConsoleProvider().connection()).toMatchObject({
      status: "NOT_CONFIGURED",
      message: expect.stringContaining("SEARCH_CONSOLE_SITE_URL"),
    });

    configure({ SEARCH_CONSOLE_SITE_URL: PROPERTY });
    expect(new GoogleSearchConsoleProvider().connection()).toMatchObject({
      status: "NOT_CONFIGURED",
      message: expect.stringContaining("credentials"),
    });

    configure({ SEARCH_CONSOLE_SITE_URL: PROPERTY, GOOGLE_SEARCH_CONSOLE_CREDENTIALS: "{not json" });
    const broken = new GoogleSearchConsoleProvider().connection();
    expect(broken.status).toBe("NOT_CONFIGURED");
    expect(broken.status === "NOT_CONFIGURED" && broken.message).not.toContain("{not json");
  });

  it("does not call Google at all when it is not configured", async () => {
    configure({});
    stubFetch(() => json({ rows: [] }));
    expect(await new GoogleSearchConsoleProvider().fetchPerformance(request)).toMatchObject({
      status: "NOT_CONFIGURED",
    });
    expect(calls).toHaveLength(0);
  });
});
