/**
 * The four products under the hero, as stored data.
 *
 * The row is what the front page is *for* now that the photograph carries no
 * words, so what is protected here is that staff own it, that nobody else can
 * change it, and that it degrades sensibly: a corrupt row, a product that has
 * since been unpublished, or a seventh product all have to leave the homepage
 * standing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, siteSettings, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  SHOWCASE_DEFAULTS,
  SHOWCASE_MAX,
  SHOWCASE_SETTING_KEY,
  addToShowcase,
  getShowcaseSettings,
  moveInShowcase,
  removeFromShowcase,
  setShowcase,
} from "@/lib/homepage";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };

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
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  staff.id = rows.find((row) => row.email === staff.email)!.id;
  customer.id = rows.find((row) => row.email === customer.email)!.id;
});

describe("reading", () => {
  it("is empty until staff choose, which means the catalogue decides", async () => {
    expect(await getShowcaseSettings()).toEqual(SHOWCASE_DEFAULTS);
  });

  it("falls back rather than throwing on a corrupt row", async () => {
    await harness.db
      .insert(siteSettings)
      .values({ key: SHOWCASE_SETTING_KEY, valueJson: { value: { slugs: "candy" } } });

    expect(await getShowcaseSettings()).toEqual(SHOWCASE_DEFAULTS);
  });
});

describe("choosing the row", () => {
  it("keeps the order staff put it in", async () => {
    await setShowcase(staff, ["candy", "syrup", "kettle"]);

    expect((await getShowcaseSettings()).slugs).toEqual([
      "candy",
      "syrup",
      "kettle",
    ]);
  });

  it("drops a duplicate rather than refusing the save", async () => {
    await setShowcase(staff, ["candy", "syrup", "candy"]);

    expect((await getShowcaseSettings()).slugs).toEqual(["candy", "syrup"]);
  });

  it("holds no more than the ceiling", async () => {
    const many = Array.from({ length: SHOWCASE_MAX + 3 }, (_, i) => `p${i}`);
    await setShowcase(staff, many);

    expect((await getShowcaseSettings()).slugs).toHaveLength(SHOWCASE_MAX);
  });

  it("adds one product from wherever staff are standing", async () => {
    await addToShowcase(staff, "candy");
    await addToShowcase(staff, "syrup");

    expect((await getShowcaseSettings()).slugs).toEqual(["candy", "syrup"]);
  });

  it("adding the same product twice changes nothing", async () => {
    await addToShowcase(staff, "candy");
    await addToShowcase(staff, "candy");

    expect((await getShowcaseSettings()).slugs).toEqual(["candy"]);
  });

  it("refuses to add past the ceiling, and says why", async () => {
    await setShowcase(
      staff,
      Array.from({ length: SHOWCASE_MAX }, (_, i) => `p${i}`),
    );

    await expect(addToShowcase(staff, "one-more")).rejects.toThrow(
      /Remove one first/,
    );
  });

  it("removes one product and leaves the rest in order", async () => {
    await setShowcase(staff, ["candy", "syrup", "kettle"]);
    await removeFromShowcase(staff, "syrup");

    expect((await getShowcaseSettings()).slugs).toEqual(["candy", "kettle"]);
  });

  it("moves a product along the row", async () => {
    await setShowcase(staff, ["candy", "syrup", "kettle"]);

    await moveInShowcase(staff, "kettle", "up");
    expect((await getShowcaseSettings()).slugs).toEqual([
      "candy",
      "kettle",
      "syrup",
    ]);

    // At the end of the row, a move is a no-op rather than an error.
    await moveInShowcase(staff, "candy", "up");
    expect((await getShowcaseSettings()).slugs).toEqual([
      "candy",
      "kettle",
      "syrup",
    ]);
  });

  it("audits every change with the row it replaced", async () => {
    await setShowcase(staff, ["candy"]);
    await addToShowcase(staff, "syrup");

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, SHOWCASE_SETTING_KEY));

    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries[1].beforeJson)).toContain("candy");
    expect(JSON.stringify(entries[1].afterJson)).toContain("syrup");
  });
});

describe("permission", () => {
  it("refuses a customer and an anonymous visitor", async () => {
    for (const actor of [customer, null]) {
      await expect(setShowcase(actor, ["candy"])).rejects.toThrow();
      await expect(addToShowcase(actor, "candy")).rejects.toThrow();
      await expect(removeFromShowcase(actor, "candy")).rejects.toThrow();
      await expect(moveInShowcase(actor, "candy", "up")).rejects.toThrow();
    }

    expect(await getShowcaseSettings()).toEqual(SHOWCASE_DEFAULTS);
  });
});
