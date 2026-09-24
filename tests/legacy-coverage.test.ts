/**
 * What still depends on the legacy catalogue tables, and the one migration
 * path out of them (D-105, finding F14).
 *
 * The migration strategy ends in a contract step, and Stage 7 was where that
 * was meant to happen. It mostly did not, and these tests are why: the report
 * counts what is actually covered, and a system is only contractable when the
 * count says so. The tests below are as much about what the report *refuses*
 * to claim as about what it reports.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pkbAliases, pkbUnmappedValues, products, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, createProductOption, generateVariants, updateProduct } from "@/lib/catalog";
import { classifyParkedValues, decideAlias, legacyCoverage, listingKeywordMigration, suggestAliasesFromKeywords } from "@/lib/pkb";
import { decideLabelMapping } from "@/lib/pkb/mappings";
import { loadDefinitions } from "@/lib/pkb/vocabulary";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let staff: SessionUser;
let customer: SessionUser;
let categoryId = "";

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
      { email: "staff@example.com", passwordHash: "x", role: "super_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email, role: users.role });
  const staffRow = rows.find((row) => row.role === "super_admin")!;
  staff = { id: staffRow.id, email: staffRow.email, role: "super_admin" };
  const customerRow = rows.find((row) => row.role === "customer")!;
  customer = { id: customerRow.id, email: customerRow.email, role: "customer" };
  const category = await createCategory(staff, { name: "Audio", slug: "audio" });
  categoryId = category.id;
});

async function listingWithKeywords(terms: string[]) {
  const product = await createProduct(staff, { title: "Studio Headphones", categoryId });
  await harness.db.update(products).set({ searchKeywords: terms }).where(eq(products.id, product.id));
  return product;
}

/*
 * Only this listing's own aliases. The system vocabulary ships with approved
 * aliases of its own for attributes and options, and counting those would make
 * every assertion below about the seed rather than about the migration.
 */
async function productAliasesOf(listingId: string) {
  const [listing] = await harness.db.select().from(products).where(eq(products.id, listingId));
  return harness.db
    .select()
    .from(pkbAliases)
    .where(and(eq(pkbAliases.targetKind, "product"), eq(pkbAliases.pkbProductId, listing.pkbProductId!)));
}

describe("the legacy coverage report", () => {
  it("counts every legacy system, and refuses to be read by a customer", async () => {
    const coverage = await legacyCoverage(staff);
    expect(coverage.systems.map((system) => system.system)).toEqual([
      "Shelf specification definitions (category_attributes)",
      "Variant option groups (attributes)",
      "Variant option selections (variant_option_values)",
      "Listing search terms (products.search_keywords)",
    ]);
    await expect(legacyCoverage(customer)).rejects.toThrow(AuthorizationError);
  });

  it("says an option group nothing has matched is in the way", async () => {
    const product = await createProduct(staff, { title: "Studio Headphones", categoryId });
    await createProductOption(staff, product.id, { name: "Ear cup finish", values: ["Walnut", "Slate"] });
    await generateVariants(staff, product.id);

    const options = (await legacyCoverage(staff)).systems.find((system) =>
      system.system.startsWith("Variant option groups"),
    )!;
    expect(options.total).toBeGreaterThan(0);
    // A bespoke option name has no knowledge attribute behind it, and the
    // report says so rather than rounding it up to "covered".
    expect(options.covered).toBeLessThan(options.total);
    expect(options.contractable).toBe(false);
    expect(options.blocking).toMatch(/not matched to a knowledge attribute/);
    expect((await legacyCoverage(staff)).allCovered).toBe(false);
  });

  /*
   * The important one. `search_keywords` is retained on purpose (D-105), so
   * the report must never report it as ready to remove — not even on a
   * database where every term has been approved as an alias. A marketing hint
   * on one listing is not a fact about the product, and a report that said
   * otherwise would eventually be acted on.
   */
  it("never calls the search-terms column contractable, whatever its coverage", async () => {
    const terms = (await legacyCoverage(staff)).systems.find((system) =>
      system.system.startsWith("Listing search terms"),
    )!;
    expect(terms.contractable).toBe(false);
    expect(terms.blocking).toMatch(/Retained/);

    const listing = await listingWithKeywords(["xm6", "studio monitors"]);
    await suggestAliasesFromKeywords(staff, listing.id);
    for (const alias of await productAliasesOf(listing.id)) {
      await decideAlias(staff, alias.id, "approved");
    }

    const after = (await legacyCoverage(staff)).systems.find((system) =>
      system.system.startsWith("Listing search terms"),
    )!;
    expect(after.covered).toBe(2);
    expect(after.total).toBe(2);
    expect(after.contractable).toBe(false);
  });
});

describe("offering a listing's search terms as aliases", () => {
  it("proposes each term as a suggestion, and approves nothing by itself", async () => {
    const listing = await listingWithKeywords(["xm6", "studio monitors"]);

    const result = await suggestAliasesFromKeywords(staff, listing.id);
    expect(result.proposed.sort()).toEqual(["studio monitors", "xm6"]);

    const aliases = await productAliasesOf(listing.id);
    expect(aliases).toHaveLength(2);
    // The whole point: a search term does not become vocabulary by being
    // migrated. Somebody still has to decide (D-094).
    expect(aliases.every((alias) => alias.status === "suggested")).toBe(true);
    expect(aliases.every((alias) => alias.createdBy === staff.id)).toBe(true);
    expect(aliases.every((alias) => alias.origin === "MANUAL_ADMIN")).toBe(true);
  });

  it("leaves the search terms exactly where they were", async () => {
    const listing = await listingWithKeywords(["xm6", "studio monitors"]);
    await suggestAliasesFromKeywords(staff, listing.id);

    const [after] = await harness.db.select().from(products).where(eq(products.id, listing.id));
    // Nothing is discarded. A term nobody approves is still a search term.
    expect(after.searchKeywords).toEqual(["xm6", "studio monitors"]);
  });

  it("proposes nothing twice, and does not re-propose a rejected term", async () => {
    const listing = await listingWithKeywords(["xm6"]);
    expect((await suggestAliasesFromKeywords(staff, listing.id)).proposed).toEqual(["xm6"]);
    expect((await suggestAliasesFromKeywords(staff, listing.id)).proposed).toEqual([]);

    const [alias] = await productAliasesOf(listing.id);
    await decideAlias(staff, alias.id, "rejected");

    const again = await suggestAliasesFromKeywords(staff, listing.id);
    expect(again.proposed).toEqual([]);
    expect(again.skipped).toEqual(["xm6"]);
    expect(await productAliasesOf(listing.id)).toHaveLength(1);
  });

  it("reports what each of a listing's terms has become", async () => {
    const listing = await listingWithKeywords(["xm6", "studio monitors"]);
    await suggestAliasesFromKeywords(staff, listing.id);
    const [first] = await productAliasesOf(listing.id);
    await decideAlias(staff, first.id, "approved");

    const migration = await listingKeywordMigration(staff, listing.id);
    expect(migration.terms).toHaveLength(2);
    expect(migration.terms.map((term) => term.status).sort()).toEqual(["approved", "suggested"]);
  });

  it("refuses a customer, at the report and at the proposal", async () => {
    const listing = await listingWithKeywords(["xm6"]);
    await expect(suggestAliasesFromKeywords(customer, listing.id)).rejects.toThrow(AuthorizationError);
    await expect(listingKeywordMigration(customer, listing.id)).rejects.toThrow(AuthorizationError);
    expect(await productAliasesOf(listing.id)).toHaveLength(0);
  });

  it("refuses a listing that does not exist", async () => {
    await expect(
      suggestAliasesFromKeywords(staff, "11111111-2222-3333-4444-555555555555"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/*
 * Stage 8 (D-109). "72 values parked" is a number an owner cannot act on, and
 * a bare count invites the two wrong actions: discarding the values, or
 * placing them by hand in the database. The report below says what each parked
 * value *is*, from the database, and the point of these tests is what it
 * refuses to say — a value is never called placeable because its label looks
 * like an attribute's.
 */
describe("classifying the parked values", () => {
  async function listingWithParkedSpec(label: string) {
    return createProduct(staff, {
      title: "Studio Headphones",
      categoryId,
      specTable: [{ label, value: "40 mm" }],
    });
  }

  it("calls a label no attribute means ambiguous, and counts it as needing a decision", async () => {
    await listingWithParkedSpec("Driver diameter");

    const report = await classifyParkedValues(staff);
    expect(report.total).toBeGreaterThan(0);
    expect(report.counts.ambiguous).toBeGreaterThan(0);
    expect(report.counts.migratable).toBe(0);
    expect(report.needingDecision).toBe(report.counts.ambiguous + report.counts.migratable);

    const group = report.groups.find((row) => row.label === "Driver diameter")!;
    expect(group.parkedClass).toBe("ambiguous");
    expect(group.legacyRef).toBe("products.spec_table");
    expect(group.definition).toBeNull();
    expect(group.rows).toBe(1);
    expect(group.listings).toBe(1);
    expect(group.samples[0].value).toBe("40 mm");
  });

  it("reports a value as placeable only after somebody has decided what its label means", async () => {
    const listing = await listingWithParkedSpec("Driver diameter");

    const before = await classifyParkedValues(staff);
    expect(before.groups.find((row) => row.label === "Driver diameter")!.parkedClass).toBe("ambiguous");

    // The one thing that may change the answer: a recorded decision. Nothing
    // about the value or the label has changed.
    const [definition] = (await loadDefinitions(harness.db)).filter((row) => row.key === "material");
    await decideLabelMapping(staff, {
      label: "Driver diameter",
      context: "spec_table",
      action: "map",
      definitionId: definition.id,
    });

    const after = await classifyParkedValues(staff);
    const group = after.groups.find((row) => row.label === "Driver diameter")!;
    expect(group.parkedClass).toBe("migratable");
    expect(group.definition).toMatchObject({ id: definition.id });

    // Reporting writes nothing: the row is still parked, waiting for the sync
    // the decision queued.
    const stillParked = await harness.db
      .select()
      .from(pkbUnmappedValues)
      .where(and(eq(pkbUnmappedValues.productId, listing.id), eq(pkbUnmappedValues.status, "open")));
    expect(stillParked.length).toBe(1);
  });

  it("calls an identifier that failed its check digit unusable, and never asks anybody to place it", async () => {
    const product = await createProduct(staff, { title: "HP-900", categoryId });
    await updateProduct(staff, product.id, { identifierType: "gtin", identifierValue: "4006381333932" });

    const report = await classifyParkedValues(staff);
    const identifier = report.groups.find((row) => row.legacyRef.startsWith("products.identifier"));
    if (identifier) {
      expect(identifier.parkedClass).toBe("unusable");
      expect(report.needingDecision).toBe(report.counts.ambiguous + report.counts.migratable);
      expect(report.counts.unusable).toBeGreaterThan(0);
    } else {
      // Stored as invalid instead of parked, which is the other allowed answer.
      expect(report.counts.unusable).toBe(0);
    }
  });

  it("refuses a customer", async () => {
    await expect(classifyParkedValues(customer)).rejects.toBeInstanceOf(AuthorizationError);
  });
});
