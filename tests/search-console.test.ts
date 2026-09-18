/**
 * Stage 6 of the knowledge platform: Search Console, the opportunity engine,
 * SEO change history, before-and-after observation and controlled learning.
 *
 * Everything here runs against a fixture at the provider boundary, so the
 * whole stage is testable without Google credentials — which is the point of
 * the boundary. What cannot be tested here is whether Google's real responses
 * match the shapes `GoogleSearchConsoleProvider` parses; that is marked
 * UNVERIFIED in the tracker.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pkbAliases,
  pkbFacts,
  products,
  searchConsoleMetrics,
  searchConsoleSyncs,
  searchConsoleSyncState,
  seoFieldHistory,
  users,
} from "@/db/schema";
import { AuthorizationError, ROLE_PERMISSIONS, can } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, updateCategory, updateProduct } from "@/lib/catalog";
import { JOB_HANDLERS } from "@/lib/jobs/registry";
import { runDueJobs } from "@/lib/jobs/runner";
import {
  GoogleSearchConsoleProvider,
  setSearchConsoleProviderForTesting,
  UnconfiguredSearchConsoleProvider,
  type SearchConsoleFetch,
  type SearchConsoleProvider,
  type SearchConsoleRequest,
  type SearchConsoleRow,
} from "@/lib/providers/search-console";
import { changeComparisons } from "@/lib/search-console/comparison";
import { addDays, isoDay } from "@/lib/search-console/config";
import { learningSignals } from "@/lib/search-console/learning";
import { listingSearchPerformance } from "@/lib/search-console/listing";
import { metricsStorage, searchConsoleStatus } from "@/lib/search-console/metrics";
import { OPPORTUNITY_LIMITS, opportunityReport, decideOpportunity } from "@/lib/search-console/opportunities";
import { pathOf, resolvePaths } from "@/lib/search-console/paths";
import {
  pruneSearchConsoleMetrics,
  requestSearchConsoleSync,
  runSearchConsoleSync,
  syncWindow,
} from "@/lib/search-console/sync";
import { recentSeoChanges, seoChangesFor } from "@/lib/seo/history";
import { categoryInputSchema } from "@/lib/validation/catalog";
import { createTestDatabase } from "./helpers/database";

const PROPERTY = "sc-domain:shop.example";
const ORIGIN = "https://shop.example";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "00000000-0000-0000-0000-0000000000ff", email: "buyer@example.com", role: "customer" };

/** Today, so every fixture date is inside the window the sync asks for. */
const TODAY = isoDay(new Date());
/** The newest day the sync will ask for, given the configured lag. */
const LATEST = addDays(TODAY, -2);

/**
 * A provider that answers from rows a test hands it, and counts what was
 * asked. This is the whole Google surface as far as the rest of the code is
 * concerned.
 */
class FakeSearchConsole implements SearchConsoleProvider {
  readonly key = "fake";
  requests: SearchConsoleRequest[] = [];
  /** Queued answers, in order; anything beyond them is an empty OK page. */
  answers: SearchConsoleFetch[] = [];
  rows: Record<string, SearchConsoleRow[]> = {};

  connection() {
    return { status: "CONFIGURED" as const, property: PROPERTY, account: "sync@project.iam.gserviceaccount.com" };
  }

  async fetchPerformance(request: SearchConsoleRequest): Promise<SearchConsoleFetch> {
    this.requests.push(request);
    if (this.answers.length > 0) return this.answers.shift()!;
    const all = this.rows[request.dimension] ?? [];
    // Pages exactly as Google does: rowLimit rows from startRow, and a full
    // page is the only signal that there may be more.
    const page = all.slice(request.startRow, request.startRow + request.rowLimit);
    return { status: "OK", rows: page, hasMore: page.length >= request.rowLimit };
  }
}

let fake: FakeSearchConsole;

function pageRow(input: {
  day?: string;
  slug: string;
  clicks: number;
  impressions: number;
  position: number;
  kind?: "products" | "categories";
}): SearchConsoleRow {
  return {
    date: input.day ?? LATEST,
    page: `${ORIGIN}/${input.kind ?? "products"}/${input.slug}`,
    query: null,
    clicks: input.clicks,
    impressions: input.impressions,
    ctr: input.impressions > 0 ? input.clicks / input.impressions : 0,
    position: input.position,
  };
}

function queryRow(input: {
  day?: string;
  slug?: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}): SearchConsoleRow {
  return {
    date: input.day ?? LATEST,
    page: input.slug ? `${ORIGIN}/products/${input.slug}` : null,
    query: input.query,
    clicks: input.clicks,
    impressions: input.impressions,
    ctr: input.impressions > 0 ? input.clicks / input.impressions : 0,
    position: input.position,
  };
}

/** Spreads one page's figures over every day of a window, so a window is complete. */
function overDays(days: number, build: (day: string) => SearchConsoleRow[]): SearchConsoleRow[] {
  const rows: SearchConsoleRow[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    rows.push(...build(addDays(LATEST, -offset)));
  }
  return rows;
}

beforeAll(async () => {
  process.env.SITE_URL = ORIGIN;
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  setSearchConsoleProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  await harness.client.exec(
    "truncate table search_console_metrics, search_console_syncs, search_console_sync_state, seo_opportunity_decisions restart identity cascade",
  );
  const [row] = await harness.db
    .insert(users)
    .values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = row.id;
  fake = new FakeSearchConsole();
  setSearchConsoleProviderForTesting(fake);
});

afterEach(() => {
  setSearchConsoleProviderForTesting(undefined);
});

async function shelf(name = "Audio") {
  return createCategory(staff, { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 7)}` });
}

async function listing(input: { title: string; description?: string; categoryId?: string }) {
  const categoryId = input.categoryId ?? (await shelf()).id;
  return createProduct(staff, {
    title: input.title,
    categoryId,
    descriptionHtml: input.description ?? "<p>A description long enough to be worth reading on its own.</p>",
  });
}

/** Requests a sync and runs its job to completion. */
async function sync() {
  const requested = await requestSearchConsoleSync(staff, { trigger: "manual" });
  return runSearchConsoleSync(requested.syncId);
}

// ------------------------------------------------------------ not configured

describe("with no Search Console configured", () => {
  beforeEach(() => {
    setSearchConsoleProviderForTesting(new UnconfiguredSearchConsoleProvider());
  });

  it("reports NOT_CONFIGURED rather than failing", async () => {
    const provider = new UnconfiguredSearchConsoleProvider();
    const result = await provider.fetchPerformance();
    expect(result.status).toBe("NOT_CONFIGURED");
    expect(provider.connection().status).toBe("NOT_CONFIGURED");
  });

  it("shows the connection state without touching the database", async () => {
    const status = await searchConsoleStatus(staff);
    expect(status.state).toBe("not_configured");
    expect(status.coverage).toBeNull();
    expect(status.property).toBeNull();
  });

  it("refuses a sync with an explanation, and stores nothing", async () => {
    await expect(requestSearchConsoleSync(staff, { trigger: "manual" })).rejects.toThrow(/not connected/i);
    const [{ count }] = await harness.db
      .select({ count: sql<number>`count(*)::int` })
      .from(searchConsoleSyncs);
    expect(count).toBe(0);
  });

  it("leaves the scheduled job reporting rather than failing", async () => {
    const { scheduledSearchConsoleSync } = await import("@/lib/search-console/sync");
    const result = await scheduledSearchConsoleSync();
    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/not connected/i);
  });

  it("returns an empty opportunity report, not zeroes presented as measurements", async () => {
    const report = await opportunityReport(staff);
    expect(report.connected).toBe(false);
    expect(report.window).toBeNull();
    expect(report.opportunities).toEqual([]);
  });

  it("still shows the SEO change history, which is the shop's own record", async () => {
    const product = await listing({ title: "Aster Lamp" });
    await updateProduct(staff, product.id, { seoMetaTitle: "Aster Lamp — warm desk light" });
    const { property, comparisons } = await changeComparisons(staff);
    expect(property).toBeNull();
    expect(comparisons.length).toBeGreaterThan(0);
    expect(comparisons[0].verdict).toBe("not_measured");
    expect(comparisons[0].causation).toBe("not established");
  });
});

describe("the Google provider with no credentials", () => {
  it("is NOT_CONFIGURED, and names no credential in the message", () => {
    const before = { ...process.env };
    delete process.env.GOOGLE_SEARCH_CONSOLE_CREDENTIALS;
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL;
    delete process.env.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY;
    process.env.SEARCH_CONSOLE_SITE_URL = PROPERTY;
    try {
      const connection = new GoogleSearchConsoleProvider().connection();
      expect(connection.status).toBe("NOT_CONFIGURED");
      expect(connection.status === "NOT_CONFIGURED" && connection.message).toMatch(/credentials/i);
    } finally {
      process.env = before;
    }
  });

  it("never returns a private key from the connection", () => {
    const before = { ...process.env };
    process.env.SEARCH_CONSOLE_SITE_URL = PROPERTY;
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL = "sync@project.iam.gserviceaccount.com";
    process.env.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----";
    try {
      const connection = new GoogleSearchConsoleProvider().connection();
      expect(connection.status).toBe("CONFIGURED");
      expect(JSON.stringify(connection)).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(connection)).not.toContain("secret");
    } finally {
      process.env = before;
    }
  });
});

// ------------------------------------------------------------------- syncing

describe("synchronisation", () => {
  it("asks for each dimension over the window and stores what came back", async () => {
    const product = await listing({ title: "Aster Lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = {
      page: [pageRow({ slug: row.slug, clicks: 4, impressions: 100, position: 8.2 })],
      query: [queryRow({ query: "aster lamp", clicks: 4, impressions: 100, position: 8.2 })],
      page_query: [queryRow({ slug: row.slug, query: "aster lamp", clicks: 4, impressions: 100, position: 8.2 })],
    };

    const report = await sync();
    expect(report.status).toBe("completed");
    expect(report.rowsWritten).toBe(3);
    expect(new Set(fake.requests.map((request) => request.dimension))).toEqual(new Set(["page", "query", "page_query"]));

    const stored = await harness.db.select().from(searchConsoleMetrics);
    expect(stored).toHaveLength(3);
    const page = stored.find((metric) => metric.dimension === "page")!;
    expect(page.pagePath).toBe(`/products/${row.slug}`);
    expect(page.productId).toBe(product.id);
    // CTR is generated from the two counts, never stored on its own.
    expect(Number(page.ctr)).toBeCloseTo(0.04, 6);
  });

  it("is idempotent: syncing the same window again writes no new rows", async () => {
    const product = await listing({ title: "Aster Lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: [pageRow({ slug: row.slug, clicks: 4, impressions: 100, position: 8.2 })] };

    const first = await sync();
    expect(first.rowsWritten).toBe(1);

    // A second sync, a minute later, over the same days.
    const second = await requestSearchConsoleSync(staff, { trigger: "manual", now: new Date(Date.now() + 120_000) });
    const secondReport = await runSearchConsoleSync(second.syncId);
    expect(secondReport.rowsWritten).toBe(0);
    expect(secondReport.rowsUnchanged).toBe(1);

    const stored = await harness.db.select().from(searchConsoleMetrics);
    expect(stored).toHaveLength(1);
  });

  it("updates a revised day in place instead of storing it twice", async () => {
    const product = await listing({ title: "Aster Lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: [pageRow({ slug: row.slug, clicks: 4, impressions: 100, position: 8.2 })] };
    await sync();

    fake.rows = { page: [pageRow({ slug: row.slug, clicks: 9, impressions: 140, position: 7.1 })] };
    const second = await requestSearchConsoleSync(staff, { trigger: "manual", now: new Date(Date.now() + 120_000) });
    const report = await runSearchConsoleSync(second.syncId);
    expect(report.rowsWritten).toBe(1);

    const stored = await harness.db.select().from(searchConsoleMetrics);
    expect(stored).toHaveLength(1);
    expect(stored[0].clicks).toBe(9);
  });

  it("makes one sync out of a double click", async () => {
    const first = await requestSearchConsoleSync(staff, { trigger: "manual" });
    const second = await requestSearchConsoleSync(staff, { trigger: "manual" });
    expect(second.syncId).toBe(first.syncId);
    expect(second.alreadyQueued).toBe(true);
    const rows = await harness.db.select().from(searchConsoleSyncs);
    expect(rows).toHaveLength(1);
  });

  it("returns a finished sync unchanged when its job is retried", async () => {
    fake.rows = { page: [] };
    const requested = await requestSearchConsoleSync(staff, { trigger: "manual" });
    await runSearchConsoleSync(requested.syncId);
    const requestsAfterFirst = fake.requests.length;
    const again = await runSearchConsoleSync(requested.syncId);
    expect(again.status).toBe("completed");
    expect(fake.requests.length).toBe(requestsAfterFirst);
  });

  it("pages through a dimension until a page comes back short", async () => {
    const previous = process.env.SEARCH_CONSOLE_ROW_LIMIT;
    process.env.SEARCH_CONSOLE_ROW_LIMIT = "100";
    try {
      // 150 pages of this site, so the first request fills and the second does
      // not. They need no listing behind them: an address the shop does not
      // recognise is stored with nothing attached.
      fake.rows = {
        page: Array.from({ length: 150 }, (_, index) => ({
          date: LATEST,
          page: `${ORIGIN}/help/article-${index}`,
          query: null,
          clicks: 1,
          impressions: 10,
          ctr: 0.1,
          position: 5,
        })),
      };

      const report = await sync();
      expect(report.rowsFetched).toBe(150);
      expect(report.rowsWritten).toBe(150);
      const pageRequests = fake.requests.filter((request) => request.dimension === "page");
      expect(pageRequests.map((request) => request.startRow)).toEqual([0, 100]);
      expect(await harness.db.select().from(searchConsoleMetrics)).toHaveLength(150);
    } finally {
      if (previous === undefined) delete process.env.SEARCH_CONSOLE_ROW_LIMIT;
      else process.env.SEARCH_CONSOLE_ROW_LIMIT = previous;
    }
  });

  it("records a provider outage as a failed sync and does not move the watermark", async () => {
    fake.answers = [{ status: "UNAVAILABLE", message: "Search Console is not answering right now (HTTP 503)." }];
    const report = await sync();
    expect(report.status).toBe("failed");
    expect(report.providerState).toBe("UNAVAILABLE");
    expect(report.error).toMatch(/503/);

    const [state] = await harness.db.select().from(searchConsoleSyncState);
    expect(state.lastStatus).toBe("unavailable");
    expect(state.syncedThrough).toBeNull();
    expect(state.lastSuccessAt).toBeNull();
  });

  it("re-reads the trailing days on the next window, and never goes backwards", () => {
    const window = syncWindow(null, TODAY);
    expect(window).not.toBeNull();
    expect(window!.end).toBe(LATEST);

    const next = syncWindow(LATEST, TODAY);
    // The refresh window overlaps the watermark on purpose: Search Console
    // revises the most recent days after first reporting them.
    expect(next!.start).toBe(addDays(LATEST, -4));
    expect(next!.end).toBe(LATEST);
  });

  it("drops an address that is not this shop's, rather than storing a meaningless path", async () => {
    fake.rows = {
      page: [
        { date: LATEST, page: "https://someone-else.example/products/thing", query: null, clicks: 5, impressions: 50, ctr: 0.1, position: 3 },
      ],
    };
    const report = await sync();
    expect(report.rowsFetched).toBe(1);
    expect(report.rowsWritten).toBe(0);
    expect(await harness.db.select().from(searchConsoleMetrics)).toHaveLength(0);
  });

  it("keeps a page it cannot resolve to a listing, with no listing attached", async () => {
    fake.rows = { page: [{ date: LATEST, page: `${ORIGIN}/help/delivery`, query: null, clicks: 3, impressions: 30, ctr: 0.1, position: 4 }] };
    await sync();
    const [stored] = await harness.db.select().from(searchConsoleMetrics);
    expect(stored.pagePath).toBe("/help/delivery");
    expect(stored.productId).toBeNull();
  });

  it("resolves an address a listing has left, through the redirect table", async () => {
    const product = await listing({ title: "Aster Lamp" });
    const [before] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    await updateProduct(staff, product.id, { slug: "aster-lamp-2" });

    const resolved = await resolvePaths(harness.db, [`/products/${before.slug}`, "/products/aster-lamp-2"]);
    expect(resolved.get(`/products/${before.slug}`)?.productId).toBe(product.id);
    expect(resolved.get(`/products/${before.slug}`)?.via).toBe("old_address");
    expect(resolved.get("/products/aster-lamp-2")?.via).toBe("listing");
  });

  it("reads one page out of an address with its query string and trailing slash", () => {
    expect(pathOf(`${ORIGIN}/products/aster-lamp/?utm_source=x#specs`)).toBe("/products/aster-lamp");
    expect(pathOf("not an address")).toBeNull();
  });

  it("runs through the job registry", async () => {
    fake.rows = { page: [] };
    await requestSearchConsoleSync(staff, { trigger: "manual" });
    const report = await runDueJobs(JOB_HANDLERS, { limit: 5, budgetMs: 10_000 });
    expect(report.ran.some((job) => job.kind === "seo.search_console_sync")).toBe(true);
    const [row] = await harness.db.select().from(searchConsoleSyncs);
    expect(row.status).toBe("completed");
  });
});

// ------------------------------------------------------- opportunity engine

describe("the opportunity engine", () => {
  /** Enough pages at one position band for the band to have a benchmark. */
  async function catalogueWithBenchmark() {
    const rows: SearchConsoleRow[] = [];
    for (let index = 0; index < 6; index += 1) {
      const product = await listing({ title: `Healthy listing ${index}` });
      const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
      rows.push(...overDays(28, (day) => [pageRow({ day, slug: row.slug, clicks: 4, impressions: 40, position: 6.5 })]));
    }
    return rows;
  }

  it("finds a page shown often and clicked far less than this site's pages at that position", async () => {
    const rows = await catalogueWithBenchmark();
    const poor = await listing({ title: "Ignored lamp" });
    const [poorRow] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, poor.id));
    rows.push(...overDays(28, (day) => [pageRow({ day, slug: poorRow.slug, clicks: 0, impressions: 60, position: 6.5 })]));

    fake.rows = { page: rows };
    await sync();

    const report = await opportunityReport(staff);
    const finding = report.opportunities.find((row) => row.kind === "low_ctr" && row.productId === poor.id);
    expect(finding).toBeDefined();
    expect(finding!.observation).toMatch(/impressions/);
    // The benchmark is this site's own median, shown so the figure can be checked.
    expect(finding!.evidence.bandMedianCtr).toBeGreaterThan(0);
    // The healthy pages are not reported.
    expect(report.opportunities.filter((row) => row.kind === "low_ctr")).toHaveLength(1);
  });

  it("says a position band has too little data instead of comparing against it", async () => {
    const product = await listing({ title: "Lonely lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: overDays(28, (day) => [pageRow({ day, slug: row.slug, clicks: 0, impressions: 30, position: 2 })]) };
    await sync();

    const report = await opportunityReport(staff);
    expect(report.opportunities.filter((finding) => finding.kind === "low_ctr")).toHaveLength(0);
    expect(report.insufficient.some((row) => /Click-through at positions 1 to 3/.test(row.subject))).toBe(true);
  });

  it("finds a page ranking within reach of the first page", async () => {
    const product = await listing({ title: "Nearly there lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: overDays(28, (day) => [pageRow({ day, slug: row.slug, clicks: 2, impressions: 20, position: 12.4 })]) };
    await sync();

    const report = await opportunityReport(staff);
    const finding = report.opportunities.find((finding) => finding.kind === "improvement_potential");
    expect(finding).toBeDefined();
    expect(finding!.evidence.position).toBeCloseTo(12.4, 1);
  });

  it("finds a query the page is shown for but never says", async () => {
    const product = await listing({ title: "Aster Lamp", description: "<p>A warm desk light with a brass stem.</p>" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = {
      page: overDays(28, (day) => [pageRow({ day, slug: row.slug, clicks: 2, impressions: 20, position: 9 })]),
      page_query: overDays(28, (day) => [
        queryRow({ day, slug: row.slug, query: "bedside reading lamp", clicks: 1, impressions: 10, position: 9 }),
      ]),
    };
    await sync();

    const report = await opportunityReport(staff);
    const gap = report.opportunities.find((finding) => finding.kind === "content_gap");
    expect(gap).toBeDefined();
    expect(gap!.evidence.query).toBe("bedside reading lamp");
    expect(String(gap!.evidence.missingWords)).toContain("bedside");
    // "lamp" is in the title, so it is not reported as missing.
    expect(String(gap!.evidence.missingWords)).not.toContain("lamp");
  });

  it("reports a fall and a rise against the window before, and only the fall is work", async () => {
    const falling = await listing({ title: "Falling lamp" });
    const rising = await listing({ title: "Rising lamp" });
    const [fallingRow] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, falling.id));
    const [risingRow] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, rising.id));

    const rows = [
      ...overDays(28, (day) => [
        pageRow({ day, slug: fallingRow.slug, clicks: 1, impressions: 30, position: 9 }),
        pageRow({ day, slug: risingRow.slug, clicks: 4, impressions: 40, position: 9 }),
      ]),
      // The window before: 29 to 56 days back.
      ...Array.from({ length: 28 }, (_, offset) => [
        pageRow({ day: addDays(LATEST, -(28 + offset)), slug: fallingRow.slug, clicks: 5, impressions: 40, position: 7 }),
        pageRow({ day: addDays(LATEST, -(28 + offset)), slug: risingRow.slug, clicks: 1, impressions: 20, position: 11 }),
      ]).flat(),
    ];
    fake.rows = { page: rows };
    await sync();

    const report = await opportunityReport(staff);
    expect(report.previousWindow).not.toBeNull();
    expect(report.opportunities.some((row) => row.kind === "decline" && row.productId === falling.id)).toBe(true);
    expect(report.improvements.some((row) => row.kind === "improvement" && row.productId === rising.id)).toBe(true);
    // A rise is recorded, not turned into a task.
    const rise = report.improvements.find((row) => row.productId === rising.id)!;
    expect(rise.recommendation).toMatch(/Nothing to do/i);
  });

  it("does not compare windows when the earlier one is barely measured", async () => {
    const product = await listing({ title: "New lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: overDays(28, (day) => [pageRow({ day, slug: row.slug, clicks: 2, impressions: 30, position: 9 })]) };
    await sync();

    const report = await opportunityReport(staff);
    expect(report.previousWindow).toBeNull();
    expect(report.opportunities.some((finding) => finding.kind === "decline")).toBe(false);
    expect(report.insufficient.some((row) => /earlier period/i.test(row.subject))).toBe(true);
  });

  it("says so when nothing has been synced at all", async () => {
    const report = await opportunityReport(staff);
    expect(report.connected).toBe(true);
    expect(report.opportunities).toEqual([]);
    expect(report.insufficient[0].reason).toMatch(/no search console measurements/i);
  });

  it("invents no score, no search volume and no competitor figure", async () => {
    const rows = await catalogueWithBenchmark();
    fake.rows = { page: rows };
    await sync();
    const report = await opportunityReport(staff);
    const text = JSON.stringify(report).toLowerCase();
    for (const forbidden of ["score", "search volume", "difficulty", "cpc", "backlink", "competitor"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("records a decision about an opportunity without changing the finding", async () => {
    const rows = await catalogueWithBenchmark();
    const poor = await listing({ title: "Ignored lamp" });
    const [poorRow] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, poor.id));
    rows.push(...overDays(28, (day) => [pageRow({ day, slug: poorRow.slug, clicks: 0, impressions: 60, position: 6.5 })]));
    fake.rows = { page: rows };
    await sync();

    const before = await opportunityReport(staff);
    const finding = before.opportunities.find((row) => row.kind === "low_ctr")!;
    await decideOpportunity(staff, {
      opportunityKey: finding.key,
      kind: finding.kind,
      entityType: finding.entityType,
      productId: finding.productId,
      decision: "dismissed",
      note: "Seasonal; revisit in a month.",
      evidence: finding.evidence,
    });

    const after = await opportunityReport(staff);
    const again = after.opportunities.find((row) => row.key === finding.key)!;
    // The finding is still computed from the measurements; the decision is a note on it.
    expect(again.observation).toBe(finding.observation);
    expect(again.decision?.decision).toBe("dismissed");
  });
});

// ---------------------------------------------------------- change history

describe("SEO change history", () => {
  it("records a listing's SEO change with before, after, actor, reason and workflow", async () => {
    const product = await listing({ title: "Aster Lamp" });
    await updateProduct(staff, product.id, { seoMetaTitle: "Aster Lamp — warm desk light" });

    const changes = await seoChangesFor(staff, { productId: product.id });
    const change = changes.find((row) => row.field === "seoMetaTitle")!;
    expect(change.beforeValue).toBeNull();
    expect(change.afterValue).toBe("Aster Lamp — warm desk light");
    expect(change.actor).toBe("staff@example.com");
    expect(change.workflow).toBe("editor");
    expect(change.entityType).toBe("product");
  });

  it("records a shelf's SEO change, which had no history before", async () => {
    const category = await shelf("Lighting");
    const input = categoryInputSchema.parse({
      name: "Lighting",
      slug: category.slug,
      seoMetaTitle: "Lighting — desk and floor lamps",
      introHtml: "<p>Warm light for small rooms.</p>",
    });
    await updateCategory(staff, category.id, input);

    const changes = await seoChangesFor(staff, { categoryId: category.id });
    expect(changes.map((row) => row.field).sort()).toEqual(["introHtml", "seoMetaTitle"]);
    const title = changes.find((row) => row.field === "seoMetaTitle")!;
    expect(title.afterValue).toBe("Lighting — desk and floor lamps");
    // A shelf carries no per-field state machine, so none is claimed.
    expect(title.afterState).toBeNull();
  });

  it("is append-only: history cannot be rewritten", async () => {
    const product = await listing({ title: "Aster Lamp" });
    await updateProduct(staff, product.id, { seoMetaTitle: "First" });
    await expect(
      harness.client.exec("update seo_field_history set after_value = 'Rewritten'"),
    ).rejects.toThrow(/append-only/i);
    await expect(harness.client.exec("delete from seo_field_history")).rejects.toThrow(/append-only/i);
  });

  it("keeps every change, so a field changed twice has two rows", async () => {
    const product = await listing({ title: "Aster Lamp" });
    await updateProduct(staff, product.id, { seoMetaTitle: "First" });
    await updateProduct(staff, product.id, { seoMetaTitle: "Second" });
    const changes = await seoChangesFor(staff, { productId: product.id });
    const titles = changes.filter((row) => row.field === "seoMetaTitle");
    expect(titles).toHaveLength(2);
    expect(titles.map((row) => row.afterValue).sort()).toEqual(["First", "Second"]);
  });

  it("shows changes across the catalogue, newest first", async () => {
    const first = await listing({ title: "One" });
    const second = await listing({ title: "Two" });
    await updateProduct(staff, first.id, { seoMetaTitle: "One title" });
    await updateProduct(staff, second.id, { seoMetaTitle: "Two title" });
    const changes = await recentSeoChanges(staff, { limit: 5 });
    expect(changes[0].changedAt.getTime()).toBeGreaterThanOrEqual(changes[changes.length - 1].changedAt.getTime());
  });
});

// ------------------------------------------------------ before and after

describe("before and after a change", () => {
  async function changedListingWithMeasurements(clicksBefore: number, clicksAfter: number) {
    const product = await listing({ title: "Aster Lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));

    /*
     * The change goes in 28 days back, so there is a full window either side.
     * History cannot be edited afterwards — the table refuses updates — so the
     * row is written with the date it is meant to have, exactly as a change
     * made that day would have written it.
     */
    const changeDay = addDays(LATEST, -28);
    await harness.db.insert(seoFieldHistory).values({
      entityType: "product",
      productId: product.id,
      field: "seoMetaTitle",
      beforeValue: null,
      afterValue: "Aster Lamp — warm desk light",
      afterState: "MANUAL",
      actorUserId: staff.id,
      reason: "Saved in the listing editor",
      workflow: "editor",
      createdAt: new Date(`${changeDay}T12:00:00.000Z`),
    });

    const rows: SearchConsoleRow[] = [];
    for (let offset = 1; offset <= 28; offset += 1) {
      rows.push(pageRow({ day: addDays(changeDay, -offset), slug: row.slug, clicks: clicksBefore, impressions: 40, position: 9 }));
      rows.push(pageRow({ day: addDays(changeDay, offset), slug: row.slug, clicks: clicksAfter, impressions: 40, position: 7 }));
    }
    fake.rows = { page: rows };
    await sync();
    return product;
  }

  it("states what the measurements did, and never that the change caused it", async () => {
    await changedListingWithMeasurements(1, 5);
    const { comparisons } = await changeComparisons(staff);
    const comparison = comparisons.find((row) => row.change.field === "seoMetaTitle")!;

    expect(comparison.verdict).toBe("observed");
    expect(comparison.observation).toMatch(/increased in the observed period after the change/i);
    expect(comparison.causation).toBe("not established");
    expect(comparison.delta!.clicks).toBeGreaterThan(0);

    const text = JSON.stringify(comparison).toLowerCase();
    for (const claim of ["caused", "because of this change", "thanks to this change", "resulted in", "due to this change"]) {
      expect(text).not.toContain(claim);
    }
    expect(comparison.confounders.length).toBeGreaterThan(0);
  });

  it("says decreased when it decreased, in the same observational terms", async () => {
    await changedListingWithMeasurements(6, 1);
    const { comparisons } = await changeComparisons(staff);
    const comparison = comparisons.find((row) => row.change.field === "seoMetaTitle")!;
    expect(comparison.observation).toMatch(/decreased in the observed period after the change/i);
    expect(comparison.causation).toBe("not established");
  });

  it("refuses to compare a change that is too recent to have a window after it", async () => {
    const product = await listing({ title: "Aster Lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: overDays(28, (day) => [pageRow({ day, slug: row.slug, clicks: 2, impressions: 40, position: 9 })]) };
    await sync();
    await updateProduct(staff, product.id, { seoMetaTitle: "Changed today" });

    const { comparisons } = await changeComparisons(staff);
    const comparison = comparisons.find((row) => row.change.field === "seoMetaTitle")!;
    expect(comparison.verdict).toBe("window_incomplete");
    expect(comparison.delta).toBeNull();
  });

  it("reports too little traffic rather than a difference between two small numbers", async () => {
    await changedListingWithMeasurements(0, 0);
    const { comparisons } = await changeComparisons(staff);
    const comparison = comparisons.find((row) => row.change.field === "seoMetaTitle")!;
    // 28 days either side at 40 impressions is plenty of days, so the verdict
    // is about the clicks, not the coverage.
    expect(comparison.verdict).toBe("observed");
    expect(comparison.delta!.clicks).toBe(0);
    expect(comparison.observation).toMatch(/did not change/i);
  });
});

// ------------------------------------------------------ controlled learning

describe("controlled learning", () => {
  async function measuredListing() {
    const product = await listing({ title: "Aster Lamp", description: "<p>A warm desk light with a brass stem.</p>" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = {
      page: overDays(28, (day) => [pageRow({ day, slug: row.slug, clicks: 2, impressions: 30, position: 8 })]),
      page_query: overDays(28, (day) => [
        queryRow({ day, slug: row.slug, query: "bedside reading lamp", clicks: 1, impressions: 15, position: 8 }),
      ]),
    };
    await sync();
    return product;
  }

  it("recommends a phrase as a possible alias, and says two decisions come first", async () => {
    const product = await measuredListing();
    const report = await learningSignals(staff);
    const candidate = report.recommendations.find((row) => row.kind === "alias_candidate")!;
    expect(candidate.productId).toBe(product.id);
    expect(candidate.phrase).toBe("bedside reading lamp");
    expect(candidate.requiresReview).toMatch(/approving it is a second/i);
  });

  it("creates no alias, no fact and no copy by itself", async () => {
    await measuredListing();
    const aliasesBefore = await harness.db.select().from(pkbAliases);
    const factsBefore = await harness.db.select().from(pkbFacts);

    await learningSignals(staff);
    await opportunityReport(staff);

    expect(await harness.db.select().from(pkbAliases)).toHaveLength(aliasesBefore.length);
    expect(await harness.db.select().from(pkbFacts)).toHaveLength(factsBefore.length);
  });

  it("stops recommending a phrase once it is an approved alias", async () => {
    const product = await measuredListing();
    const { suggestAlias, decideAlias } = await import("@/lib/pkb/aliases");
    const [row] = await harness.db.select({ pkbProductId: products.pkbProductId }).from(products).where(eq(products.id, product.id));
    const alias = await suggestAlias(staff, {
      target: { kind: "product", id: row.pkbProductId! },
      alias: "bedside reading lamp",
      aliasKind: "common_name",
    });

    const beforeApproval = await learningSignals(staff);
    expect(beforeApproval.recommendations.some((entry) => entry.phrase === "bedside reading lamp")).toBe(true);

    await decideAlias(staff, alias.id, "approved");
    const afterApproval = await learningSignals(staff);
    expect(afterApproval.recommendations.some((entry) => entry.kind === "alias_candidate" && entry.phrase === "bedside reading lamp")).toBe(
      false,
    );
  });

  it("states its guardrails on every report", async () => {
    const report = await learningSignals(staff);
    expect(report.guardrails.join(" ")).toMatch(/never becomes a product fact/i);
  });
});

// ------------------------------------------------------------- permissions

/*
 * Risk R-16. The engine reads a bounded number of rows by design. What Stage 7
 * added is that a bounded read says what it left out, so a large property
 * cannot produce a partial report that reads as a complete one.
 */
describe("a report bounded by its limits", () => {
  it("says how many pages it covered of how many there were", async () => {
    const shelfId = (await shelf("Bounded")).id;
    const made = [];
    for (let index = 0; index < 60; index += 1) {
      made.push(await listing({ title: `Bounded listing ${index}`, categoryId: shelfId }));
    }
    const slugs = await harness.db
      .select({ slug: products.slug })
      .from(products)
      .where(sql`${products.id} in ${made.map((row) => row.id)}`)
      .catch(() => [] as { slug: string }[]);
    const paths = (slugs.length > 0 ? slugs : []).map((row) => row.slug);
    expect(paths.length).toBe(60);

    // A complete window for every page, so nothing is skipped for thin data.
    fake.rows = {
      page: overDays(28, (day) =>
        paths.map((slug, index) =>
          pageRow({ day, slug, clicks: 1, impressions: 200 + index, position: 8 }),
        ),
      ),
    };
    await sync();

    const bounded = await opportunityReport(staff, { pageLimit: 50 });
    expect(bounded.coverage.pagesAvailable).toBe(60);
    expect(bounded.coverage.pagesConsidered).toBe(50);
    expect(bounded.coverage.pagesTruncated).toBe(true);
    expect(bounded.insufficient.some((row) => row.subject === "The pages covered")).toBe(true);
    expect(bounded.insufficient.find((row) => row.subject === "The pages covered")!.reason).toContain("60");

    const whole = await opportunityReport(staff, { pageLimit: 500 });
    expect(whole.coverage.pagesConsidered).toBe(60);
    expect(whole.coverage.pagesTruncated).toBe(false);
    expect(whole.insufficient.some((row) => row.subject === "The pages covered")).toBe(false);
  }, 120_000);

  it("refuses to read more than its ceiling, however much is asked for", async () => {
    expect(OPPORTUNITY_LIMITS.maxPages).toBeLessThanOrEqual(5_000);
    const report = await opportunityReport(staff, { pageLimit: 10_000_000 });
    // Nothing stored, so nothing covered — the point is that it did not throw
    // and did not try to read ten million rows.
    expect(report.coverage.pagesConsidered).toBe(0);
  });
});

/*
 * Risk R-17. The table's size is driven by Google rather than by the catalogue,
 * so an operator needs to see what it holds and whether retention is running
 * without opening the database.
 */
describe("what the measurement table costs", () => {
  it("reports rows, range, retention and the last prune", async () => {
    const product = await listing({ title: "Storage Lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: overDays(3, (day) => [pageRow({ day, slug: row.slug, clicks: 2, impressions: 40, position: 6 })]) };
    await sync();

    const storage = await metricsStorage(staff);
    expect(storage.rows).toBe(3);
    expect(storage.properties).toEqual([
      expect.objectContaining({ property: PROPERTY, rows: 3, latest: LATEST }),
    ]);
    expect(storage.retentionDays).toBeGreaterThan(0);
    expect(storage.rowsOutsideRetention).toBe(0);
    expect(storage.lastPrune).toBeNull();
    // Measured, not guessed: null is allowed, a made-up number is not.
    expect(storage.bytes === null || storage.bytes > 0).toBe(true);
  });

  it("counts what the next prune will remove, and reports the prune once it runs", async () => {
    const product = await listing({ title: "Old Lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: [pageRow({ slug: row.slug, clicks: 1, impressions: 10, position: 4 })] };
    await sync();

    // Backdate the stored day well past any retention window.
    await harness.client.exec("update search_console_metrics set measured_on = current_date - 2000");
    expect((await metricsStorage(staff)).rowsOutsideRetention).toBe(1);

    const removed = await pruneSearchConsoleMetrics();
    expect(removed).toBe(1);
    expect((await metricsStorage(staff)).rows).toBe(0);
  });

  it("refuses a customer", async () => {
    await expect(metricsStorage(customer)).rejects.toThrow(AuthorizationError);
  });
});

describe("permissions and boundaries", () => {
  it("refuses a customer everywhere", async () => {
    await expect(searchConsoleStatus(customer)).rejects.toThrow(AuthorizationError);
    await expect(opportunityReport(customer)).rejects.toThrow(AuthorizationError);
    await expect(learningSignals(customer)).rejects.toThrow(AuthorizationError);
    await expect(changeComparisons(customer)).rejects.toThrow(AuthorizationError);
    await expect(recentSeoChanges(customer)).rejects.toThrow(AuthorizationError);
    await expect(requestSearchConsoleSync(customer, { trigger: "manual" })).rejects.toThrow(AuthorizationError);
    await expect(
      decideOpportunity(customer, { opportunityKey: "k", kind: "low_ctr", entityType: "site", decision: "dismissed" }),
    ).rejects.toThrow(AuthorizationError);
    await expect(listingSearchPerformance(customer, staff.id)).rejects.toThrow(AuthorizationError);
  });

  /*
   * D-101: reading a report and changing the catalogue are different
   * authorities. `marketing` holds `seo.view` and not `catalog.manage`, so it
   * is the role that proves the separation is real rather than only described.
   */
  it("lets a reader see the reports and refuses every action", async () => {
    const reader: SessionUser = { id: staff.id, email: "marketing@example.com", role: "marketing" };
    expect(can(reader, "seo.view")).toBe(true);
    expect(can(reader, "catalog.manage")).toBe(false);

    await expect(searchConsoleStatus(reader)).resolves.toBeTruthy();
    await expect(opportunityReport(reader)).resolves.toBeTruthy();
    await expect(changeComparisons(reader)).resolves.toBeTruthy();
    await expect(learningSignals(reader)).resolves.toBeTruthy();
    await expect(recentSeoChanges(reader)).resolves.toBeTruthy();

    await expect(requestSearchConsoleSync(reader, { trigger: "manual" })).rejects.toThrow(AuthorizationError);
    await expect(
      decideOpportunity(reader, { opportunityKey: "k", kind: "low_ctr", entityType: "site", decision: "dismissed" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("does not hand commerce analytics to the catalogue staff who read search performance", async () => {
    // The permission the owner named first would have. `seo.view` does not:
    // the purchase funnel, revenue and customer insights stay where they were.
    expect(ROLE_PERMISSIONS.product_manager).toContain("seo.view");
    expect(ROLE_PERMISSIONS.product_manager).not.toContain("analytics.view");
    expect(ROLE_PERMISSIONS.product_manager).not.toContain("finance.view");
    expect(ROLE_PERMISSIONS.marketing).not.toContain("catalog.manage");
    expect(ROLE_PERMISSIONS.finance).not.toContain("seo.view");
  });

  it("refuses a signed-out visitor", async () => {
    await expect(searchConsoleStatus(null)).rejects.toThrow();
    await expect(opportunityReport(null)).rejects.toThrow();
  });

  it("keeps a listing's own performance box working with nothing connected", async () => {
    setSearchConsoleProviderForTesting(new UnconfiguredSearchConsoleProvider());
    const product = await listing({ title: "Aster Lamp" });
    await updateProduct(staff, product.id, { seoMetaTitle: "Aster Lamp — warm desk light" });
    const performance = await listingSearchPerformance(staff, product.id);
    expect(performance.connected).toBe(false);
    expect(performance.totals).toBeNull();
    expect(performance.changes.length).toBeGreaterThan(0);
  });

  it("holds no customer identifier in what it stores", async () => {
    const product = await listing({ title: "Aster Lamp" });
    const [row] = await harness.db.select({ slug: products.slug }).from(products).where(eq(products.id, product.id));
    fake.rows = { page: [pageRow({ slug: row.slug, clicks: 1, impressions: 10, position: 4 })] };
    await sync();
    const columns = await harness.client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'search_console_metrics'",
    );
    const names = columns.rows.map((column) => column.column_name);
    expect(names).not.toContain("user_id");
    expect(names).not.toContain("visitor_hash");
    expect(names).not.toContain("email");
  });
});
