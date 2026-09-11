/**
 * Search analytics and search history.
 *
 * The rules with a privacy edge get the most attention here: a query is only
 * shown to other shoppers once three different visitors have run it and it
 * found something, anything shaped like an email or phone number is never
 * stored, and a customer's history is theirs alone and goes with the account.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchHistory, searchQueries, users } from "@/db/schema";
import { anonymiseCustomer } from "@/lib/auth/anonymise";
import type { SessionUser } from "@/lib/auth/session";
import {
  logSearch,
  popularSearches,
  pruneSearchLogs,
  searchReport,
  trendingSearches,
} from "@/lib/search/analytics";
import {
  HISTORY_LIMIT,
  clearSearchHistory,
  listSearchHistory,
  recordSearchHistory,
  removeSearchHistory,
} from "@/lib/search/history";
import { analyticsWindow, visitorHash } from "@/lib/search/visitor";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const admin: SessionUser = { id: "", email: "admin@example.com", role: "super_admin" };
const alice: SessionUser = { id: "", email: "alice@example.com", role: "customer" };
const bob: SessionUser = { id: "", email: "bob@example.com", role: "customer" };

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const rows = await harness.db
    .insert(users)
    .values([staff, admin, alice, bob].map((user) => ({
      email: user.email,
      passwordHash: "x",
      role: user.role,
    })))
    .returning({ id: users.id });
  [staff.id, admin.id, alice.id, bob.id] = rows.map((row) => row.id);
});

const search = (query: string, visitor: string, resultsCount = 5, now?: Date) =>
  logSearch({ query, resultsCount, correctedQuery: null, visitorHash: visitor, now });

describe("recording searches", () => {
  it("counts a visitor's repeated search once per half hour", async () => {
    const now = new Date("2026-09-10T10:05:00Z");
    await search("kettle", "v1", 3, now);
    await search("Kettle ", "v1", 3, new Date("2026-09-10T10:20:00Z"));
    await search("kettle", "v1", 3, new Date("2026-09-10T10:45:00Z"));

    expect(await harness.db.select().from(searchQueries)).toHaveLength(2);
  });

  it("never stores a search that looks like an email or a phone number", async () => {
    await search("someone@example.com", "v1");
    await search("01712 345678", "v1");

    expect(await harness.db.select().from(searchQueries)).toHaveLength(0);
  });

  it("derives a visitor that changes each day and needs the secret", () => {
    const secret = "s".repeat(32);
    const monday = visitorHash("1.2.3.4", "Firefox", new Date("2026-09-07T10:00:00Z"), secret);
    const tuesday = visitorHash("1.2.3.4", "Firefox", new Date("2026-09-08T10:00:00Z"), secret);

    expect(monday).not.toBe(tuesday);
    expect(monday).not.toContain("1.2.3.4");
    expect(visitorHash("1.2.3.4", "Firefox", new Date("2026-09-07T10:00:00Z"), "t".repeat(32))).not.toBe(monday);
    expect(analyticsWindow(new Date("2026-09-10T10:44:59Z")).toISOString()).toBe(
      "2026-09-10T10:30:00.000Z",
    );
  });
});

describe("popular and trending", () => {
  it("shows a search only once three different people ran it and it found something", async () => {
    await search("kettle", "v1");
    await search("kettle", "v2");
    expect(await popularSearches()).toEqual([]);

    await search("kettle", "v3");
    expect(await popularSearches()).toEqual(["kettle"]);

    // Three people finding nothing is a gap, not a suggestion.
    for (const visitor of ["v1", "v2", "v3"]) await search("unicorn", visitor, 0);
    expect(await popularSearches()).toEqual(["kettle"]);
  });

  it("completes a prefix from popular searches but not the prefix itself", async () => {
    for (const visitor of ["v1", "v2", "v3"]) await search("kettle stove", visitor);
    expect(await popularSearches({ prefix: "kett" })).toEqual(["kettle stove"]);
    expect(await popularSearches({ prefix: "kettle stove" })).toEqual([]);
  });

  it("calls a search trending when this week beats last week twice over", async () => {
    for (const visitor of ["v1", "v2", "v3"]) await search("carafe", visitor);
    expect(await trendingSearches()).toEqual(["carafe"]);
  });
});

describe("the report", () => {
  it("counts searches, visitors and what found nothing, for staff only", async () => {
    await search("kettle", "v1");
    await search("kettle", "v2");
    await search("unicorn", "v1", 0);

    await expect(searchReport(alice)).rejects.toMatchObject({ status: 403 });

    const report = await searchReport(staff, 30);
    expect(report).toMatchObject({ searches: 3, visitors: 2, zeroResultSearches: 1 });
    expect(report.top[0]).toMatchObject({ query: "kettle", searches: 2, visitors: 2 });
    expect(report.zeroResults.map((row) => row.query)).toEqual(["unicorn"]);
    expect(report.clickThroughRate).toBe(0);
    expect(report.missing.length).toBeGreaterThan(0);
  });

  it("prunes rows older than six months", async () => {
    await search("old", "v1", 1, new Date(Date.now() - 200 * 86_400_000));
    await search("new", "v1", 1);

    expect(await pruneSearchLogs()).toMatchObject({ queries: 1 });
    expect((await harness.db.select().from(searchQueries)).map((row) => row.query)).toEqual(["new"]);
  });
});

describe("history", () => {
  it("keeps a customer's own searches, newest first, and nobody else's", async () => {
    await recordSearchHistory(alice, "kettle");
    await recordSearchHistory(alice, "grinder");
    await recordSearchHistory(bob, "skillet");
    await recordSearchHistory(alice, "Kettle");

    expect(await listSearchHistory(alice)).toEqual(["Kettle", "grinder"]);
    expect(await listSearchHistory(bob)).toEqual(["skillet"]);
  });

  it("removes one, clears all, and keeps no more than the limit", async () => {
    for (let index = 0; index < HISTORY_LIMIT + 5; index++) {
      await recordSearchHistory(alice, `search ${index}`);
    }
    expect(await harness.db.select().from(searchHistory)).toHaveLength(HISTORY_LIMIT);

    await removeSearchHistory(alice, `search ${HISTORY_LIMIT + 4}`);
    expect(await listSearchHistory(alice, 1)).toEqual([`search ${HISTORY_LIMIT + 3}`]);

    await clearSearchHistory(alice);
    expect(await listSearchHistory(alice)).toEqual([]);
  });

  it("does not keep personal-looking searches, and refuses anyone signed out", async () => {
    await recordSearchHistory(alice, "alice@example.com");
    expect(await listSearchHistory(alice)).toEqual([]);
    await expect(listSearchHistory(null)).rejects.toMatchObject({ status: 401 });
  });

  it("goes with the account when it is anonymised", async () => {
    await recordSearchHistory(alice, "kettle");
    await anonymiseCustomer(admin, alice.id);
    expect(await harness.db.select().from(searchHistory)).toHaveLength(0);
  });
});
