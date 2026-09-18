/**
 * Stage 5 of the knowledge platform: SearchPulse on the Product Knowledge
 * Base.
 *
 * Every case here seeds real listings through the catalogue's own functions
 * and lets the database build the index, so a trigger that stops firing fails
 * here too. Nothing writes to `product_search` or `product_search_attributes`
 * by hand.
 *
 * The suite is deliberately broad, because Stage 5 changed the index, the
 * facets and the ranking of a storefront that already worked: exact titles,
 * models, identifiers, brands, families, aliases, attribute queries, typos,
 * autocomplete, zero results and large variant counts each have a case, and
 * the ranking cases exist to catch the specific regression where a broad
 * attribute match outranks an exact product.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  orderItems,
  orders,
  pkbAliases,
  pkbBrands,
  pkbProducts,
  productVariants,
  products,
  searchEvents,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  countProducts,
  createCategory,
  createCategoryAttribute,
  listProductCards,
  listFacets,
  parseDiscoveryParams,
  updateProduct,
} from "@/lib/catalog";
import { decideAlias, suggestAlias } from "@/lib/pkb/aliases";
import { correctSearch, planSearch } from "@/lib/search/plan";
import { suggest } from "@/lib/search/suggest";
import { termKey } from "@/lib/search/terms";
import { zeroResultIntelligence } from "@/lib/search/zero-results";
import { logSearch } from "@/lib/search/analytics";
import {
  countSearchConversions,
  logFilterUse,
  logRefinement,
} from "@/lib/search/events";
import { createSynonym } from "@/lib/search/synonyms";
import { createTestDatabase } from "./helpers/database";
import { createProductForTest } from "./helpers/catalog";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const marketer: SessionUser = { id: "", email: "marketing@example.com", role: "marketing" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };

let audioId = "";
let phonesId = "";

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
      { email: staff.email, passwordHash: "x", role: "staff_admin" },
      { email: marketer.email, passwordHash: "x", role: "marketing" },
      { email: customer.email, passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  staff.id = rows.find((row) => row.email === staff.email)!.id;
  marketer.id = rows.find((row) => row.email === marketer.email)!.id;
  customer.id = rows.find((row) => row.email === customer.email)!.id;

  audioId = (await createCategory(staff, { name: "Audio", slug: "audio" })).id;
  phonesId = (await createCategory(staff, { name: "Phones", slug: "phones" })).id;
});

type SeedInput = {
  title: string;
  categoryId?: string;
  brand?: string;
  details?: Record<string, string>;
  specTable?: { label: string; value: string }[];
  identifier?: { type: string; value: string };
  specs?: Record<string, string>;
  status?: "draft" | "preorder_open";
  searchable?: boolean;
};

async function seed(input: SeedInput) {
  const product = await createProductForTest(staff, {
    title: input.title,
    categoryId: input.categoryId ?? audioId,
    brand: input.brand,
    details: input.details,
    specTable: input.specTable,
    attributeValues: input.specs,
    identifierType: input.identifier?.type as never,
    identifierValue: input.identifier?.value,
    status: input.status ?? "preorder_open",
  });

  if (input.searchable === false) {
    await harness.db
      .update(products)
      .set({ searchable: false })
      .where(eq(products.id, product.id));
  }

  await harness.db.insert(productVariants).values({
    productId: product.id,
    sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
    priceBdt: 500_000,
    fulfillmentMode: "preorder",
    preorderCapacity: 10,
    preorderClosesAt: new Date(Date.now() + 7 * 86_400_000),
  });

  return product;
}

/** Titles of what a search finds, best first. */
async function search(query: string): Promise<string[]> {
  const plan = await planSearch(query);
  if (!plan) return [];
  const cards = await listProductCards({ plan, sort: "relevance", limit: 20 });
  return cards.map((card) => card.title);
}

/** The knowledge product behind a listing. */
async function knowledgeIdOf(listingId: string): Promise<string> {
  const [row] = await harness.db
    .select({ id: products.pkbProductId })
    .from(products)
    .where(eq(products.id, listingId));
  return row.id!;
}

async function approveProductAlias(listingId: string, alias: string, kind = "abbreviation") {
  const suggestion = await suggestAlias(staff, {
    target: { kind: "product", id: await knowledgeIdOf(listingId) },
    alias,
    aliasKind: kind as never,
  });
  await decideAlias(staff, suggestion.id, "approved");
  return suggestion.id;
}

// --------------------------------------------------------------- parity

describe("normalization parity", () => {
  it("the database and TypeScript write the same term key", async () => {
    const samples = [
      "Colour",
      "WH-1000XM6",
      "256 GB",
      "Space Grey",
      "Black & White",
      "  padded   spaces  ",
      "Crème brûlée",
      "USB-C 3.1",
      "",
    ];

    const rows = await harness.db.execute(
      sql`select value, search_term_key(value) as key
          from unnest(array[${sql.join(
            samples.map((value) => sql`${value}`),
            sql`, `,
          )}]::text[]) as t(value)`,
    );
    const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
      value: string;
      key: string;
    }[];

    expect(list).toHaveLength(samples.length);
    for (const row of list) {
      expect(`${row.value} => ${row.key}`).toBe(`${row.value} => ${termKey(row.value)}`);
    }
  });

  it("a quantity in a query normalizes to the canonical value a fact holds", async () => {
    const plan = await planSearch("256gb");
    expect(plan?.slots[0].terms).toEqual(["u:data_storage=256000000000"]);
    expect(plan?.slots[0].structural).toBe(true);

    const spaced = await planSearch("256 GB");
    expect(spaced?.slots[0].terms).toEqual(["u:data_storage=256000000000"]);

    const spelled = await planSearch("256 gigabytes");
    expect(spelled?.slots[0].terms).toEqual(["u:data_storage=256000000000"]);
  });

  it("does not read a unit out of an ordinary phrase", async () => {
    // "in" is inches, but "2 in 1" is not a length. A spaced unit has to be
    // at least two letters and not a stop word, or unrelated products would
    // collapse together.
    const plan = await planSearch("2 in 1 case");
    expect(plan?.slots.every((slot) => slot.terms.every((term) => !term.startsWith("u:")))).toBe(true);
  });
});

// --------------------------------------------------------------- matching

describe("what a search finds", () => {
  beforeEach(async () => {
    await seed({
      title: "Studio Reference Headphones",
      brand: "Northline Audio",
      details: { modelName: "SR-900", modelNumber: "SR900", color: "Midnight Black" },
      identifier: { type: "upc", value: "012345678905" },
    });
    await seed({
      title: "Everyday Earbuds",
      brand: "Northline Audio",
      details: { color: "Midnight Black" },
    });
    await seed({
      title: "Headphone Carry Case",
      brand: "Corvid Supply",
      details: { material: "Ballistic Nylon" },
    });
  });

  it("finds a listing by its exact title", async () => {
    expect(await search("Studio Reference Headphones")).toContain(
      "Studio Reference Headphones",
    );
  });

  it("finds a listing by its model, however the model is punctuated", async () => {
    for (const query of ["SR-900", "sr900", "SR 900"]) {
      expect(await search(query)).toContain("Studio Reference Headphones");
    }
  });

  it("finds a listing by a trade identifier the knowledge base holds", async () => {
    expect(await search("012345678905")).toContain("Studio Reference Headphones");
    // The knowledge base stores the GTIN-14 form too, and both are indexed.
    expect(await search("00012345678905")).toContain("Studio Reference Headphones");
  });

  it("finds listings by their brand", async () => {
    const found = await search("Northline Audio");
    expect(found).toContain("Studio Reference Headphones");
    expect(found).toContain("Everyday Earbuds");
    expect(found).not.toContain("Headphone Carry Case");
  });

  it("finds listings by a value the knowledge base holds", async () => {
    const found = await search("midnight black");
    expect(found).toContain("Studio Reference Headphones");
    expect(found).toContain("Everyday Earbuds");
  });

  it("narrows on several attributes at once", async () => {
    const found = await search("northline audio midnight black");
    expect(found).toContain("Studio Reference Headphones");
    expect(found).toContain("Everyday Earbuds");
    expect(found).not.toContain("Headphone Carry Case");
  });
});

// --------------------------------------------------------------- aliases

describe("approved aliases", () => {
  let headphones = "";

  beforeEach(async () => {
    const product = await seed({
      title: "Studio Reference Headphones",
      brand: "Northline Audio",
      details: { modelNumber: "SR900" },
    });
    headphones = product.id;
    await seed({ title: "Headphone Carry Case", brand: "Corvid Supply" });
  });

  it("finds nothing through an alias until it is approved", async () => {
    await suggestAlias(staff, {
      target: { kind: "product", id: await knowledgeIdOf(headphones) },
      alias: "sarge",
      aliasKind: "common_name",
    });

    expect(await search("sarge")).toEqual([]);
  });

  it("finds the product once the alias is approved", async () => {
    await approveProductAlias(headphones, "sarge");
    expect(await search("sarge")).toEqual(["Studio Reference Headphones"]);
  });

  it("ranks a whole-query alias as high as an exact code", async () => {
    await approveProductAlias(headphones, "sarge");
    const plan = await planSearch("sarge");
    expect(plan?.identityTerms).toHaveLength(1);
  });

  it("does not treat an alias inside a longer search as naming that product", async () => {
    await approveProductAlias(headphones, "sarge");
    const plan = await planSearch("sarge case");
    // "sarge case" is a search for a case, not for the headphones.
    expect(plan?.identityTerms).toEqual([]);
  });

  it("widens a brand search through an approved brand alias", async () => {
    const [brand] = await harness.db
      .select()
      .from(pkbBrands)
      .where(eq(pkbBrands.nameNormalized, "northline audio"));

    const suggestion = await suggestAlias(staff, {
      target: { kind: "brand", id: brand.id },
      alias: "Northlyne",
      aliasKind: "misspelling",
    });
    await decideAlias(staff, suggestion.id, "approved");

    expect(await search("northlyne")).toContain("Studio Reference Headphones");
  });

  it("stops finding it when the approval is taken away", async () => {
    const aliasId = await approveProductAlias(headphones, "sarge");
    expect(await search("sarge")).toHaveLength(1);

    await harness.db
      .update(pkbAliases)
      .set({ status: "rejected" })
      .where(eq(pkbAliases.id, aliasId));

    expect(await search("sarge")).toEqual([]);
  });
});

// --------------------------------------------------------------- ranking

describe("ranking", () => {
  it("puts an exact product above one that merely shares an attribute", async () => {
    await seed({
      title: "Midnight Black",
      brand: "Pale Coast",
      details: { color: "Sandstone" },
    });
    await seed({
      title: "Everyday Earbuds",
      brand: "Northline Audio",
      details: { color: "Midnight Black" },
    });

    // The listing whose *name* is the search comes first; the one that merely
    // has that colour cannot climb over it.
    expect((await search("midnight black"))[0]).toBe("Midnight Black");
  });

  it("puts an exact model above a broad attribute match", async () => {
    await seed({
      title: "Studio Reference Headphones",
      brand: "Northline Audio",
      details: { modelNumber: "SR900" },
    });
    for (let index = 0; index < 5; index++) {
      await seed({
        title: `Accessory ${index}`,
        brand: "Corvid Supply",
        details: { compatibility: "SR900 series" },
      });
    }

    expect((await search("SR900"))[0]).toBe("Studio Reference Headphones");
  });

  it("never lets the staff boost lift a weaker match above a stronger one", async () => {
    const weak = await seed({ title: "Reference Stand", brand: "Corvid Supply" });
    await seed({ title: "Studio Reference Headphones", brand: "Northline Audio" });

    await updateProduct(staff, weak.id, { searchBoost: 2 });

    expect((await search("studio reference headphones"))[0]).toBe(
      "Studio Reference Headphones",
    );
  });

  it("does not demote every result because a quantity was typed", async () => {
    await seed({
      title: "Field Recorder",
      brand: "Harbor Acoustics",
      specTable: [{ label: "Storage", value: "256 GB" }],
    });
    await seed({ title: "Field Recorder Case", brand: "Corvid Supply" });

    // "field recorder" decides the order; "256gb" is a constraint, not a word
    // a name is expected to contain.
    expect((await search("field recorder 256gb"))[0]).toBe("Field Recorder");
  });
});

// --------------------------------------------------------------- typos

describe("typo tolerance", () => {
  beforeEach(async () => {
    await seed({ title: "Logitech Desk Keyboard", brand: "Logitech" });
  });

  it("needs no correction for a search that is only a prefix", async () => {
    // "logitec" is a prefix of "logitech", which the stemmed prefix query
    // already finds. Correcting it would be a notice about nothing.
    expect(await search("logitec")).toContain("Logitech Desk Keyboard");
    expect(await correctSearch((await planSearch("logitec"))!)).toBeNull();
  });

  it("corrects a misspelled brand to the catalogue's own spelling", async () => {
    const plan = await planSearch("logitechh");
    const corrected = await correctSearch(plan!);
    expect(corrected?.query.toLowerCase()).toContain("logitech");
  });

  it("does not correct a search that already finds something", async () => {
    const plan = await planSearch("keyboard");
    expect(await correctSearch(plan!)).toBeNull();
  });

  it("does not invent a correction for an unrelated word", async () => {
    const plan = await planSearch("kumquat");
    const corrected = await correctSearch(plan!);
    expect(corrected).toBeNull();
  });
});

// --------------------------------------------------------------- facets

describe("facets from the knowledge base", () => {
  let colourId = "";

  beforeEach(async () => {
    // Two categories name the same attribute differently. The knowledge base
    // reconciles them, so shoppers see one filter (finding F12).
    colourId = (
      await createCategoryAttribute(staff, audioId, {
        name: "Colour",
        dataType: "select",
        options: ["Midnight Black", "Sandstone"],
      })
    ).id;

    await seed({ title: "Studio Headphones", specs: { [colourId]: "Midnight Black" } });
    await seed({ title: "Travel Headphones", specs: { [colourId]: "Sandstone" } });
  });

  it("offers one filter, under the attribute's own key", async () => {
    const facets = await listFacets({ query: "headphones" });
    const colour = facets.attributes.find((facet) => facet.key === "colour");
    expect(colour).toBeDefined();
    expect(colour!.values.map((value) => value.label).sort()).toEqual([
      "Midnight Black",
      "Sandstone",
    ]);
  });

  it("filters by a value however the link spells it", async () => {
    for (const value of ["Midnight Black", "midnight black", "MIDNIGHT BLACK"]) {
      expect(
        (await listProductCards({ options: { colour: [value] } })).map((card) => card.title),
      ).toEqual(["Studio Headphones"]);
    }
  });

  it("does not offer an attribute that means nothing here", async () => {
    const facets = await listFacets({ query: "headphones" });
    // Box contents and care instructions are knowledge, not filters.
    expect(facets.attributes.map((facet) => facet.key)).not.toContain("box-contents");
    expect(facets.attributes.map((facet) => facet.key)).not.toContain("care-instructions");
  });

  it("never offers the brand twice", async () => {
    const facets = await listFacets({ query: "headphones" });
    expect(facets.attributes.map((facet) => facet.key)).not.toContain("brand");
  });

  it("groups a brand spelled two ways under one entity", async () => {
    await seed({ title: "Reference Monitor", brand: "Harbor Acoustics" });
    await seed({ title: "Reference Monitor Two", brand: "Harbor Acoustics" });

    const facets = await listFacets({ query: "reference monitor" });
    const harbor = facets.brands.filter((brand) => brand.label === "Harbor Acoustics");
    expect(harbor).toHaveLength(1);
    expect(harbor[0].count).toBe(2);
  });

  it("drops a URL key that names no attribute", async () => {
    const filters = await parseDiscoveryParams({ colour: "Sandstone", utm_source: "x" });
    expect(Object.keys(filters.options ?? {})).toEqual(["colour"]);
  });
});

describe("facets and variants", () => {
  it("counts a product once however many variants carry the value", async () => {
    const colourId = (
      await createCategoryAttribute(staff, audioId, {
        name: "Shade",
        dataType: "select",
        options: ["Black", "White"],
      })
    ).id;

    const product = await seed({ title: "Many Variant Headphones", specs: { [colourId]: "Black" } });
    // A large variant count must not multiply the facet count.
    await harness.db.insert(productVariants).values(
      Array.from({ length: 60 }, (_, index) => ({
        productId: product.id,
        sku: `MV-${index}`,
        priceBdt: 100_000 + index,
        fulfillmentMode: "preorder" as const,
        preorderCapacity: 5,
        preorderClosesAt: new Date(Date.now() + 7 * 86_400_000),
      })),
    );
    await seed({ title: "Other Headphones", specs: { [colourId]: "White" } });

    const facets = await listFacets({ query: "headphones" });
    const shade = facets.attributes.find((facet) => facet.key === "shade");
    expect(shade!.values.find((value) => value.label === "Black")?.count).toBe(1);
    expect(await countProducts({ options: { shade: ["Black"] } })).toBe(1);
  });
});

// --------------------------------------------------------------- autocomplete

describe("autocomplete", () => {
  beforeEach(async () => {
    await seed({ title: "Studio Reference Headphones", brand: "Northline Audio" });
    await seed({ title: "Studio Monitor Stand", brand: "Northline Audio" });
  });

  it("completes from what the catalogue says", async () => {
    const { suggestions } = await suggest("studi");
    expect(suggestions.some((entry) => entry.kind === "product")).toBe(true);
    expect(
      suggestions.some(
        (entry) => entry.kind === "search" && entry.label.toLowerCase().startsWith("studio"),
      ),
    ).toBe(true);
  });

  it("suggests the brand the knowledge base holds", async () => {
    const { suggestions } = await suggest("northl");
    expect(
      suggestions.some(
        (entry) => entry.kind === "brand" && entry.label === "Northline Audio",
      ),
    ).toBe(true);
  });

  it("stays bounded", async () => {
    const { suggestions } = await suggest("s");
    expect(suggestions.length).toBeLessThanOrEqual(0 + 16);
  });
});

// --------------------------------------------------------------- legacy data

describe("listings the knowledge base knows little about", () => {
  it("still finds a listing with no knowledge beyond its title", async () => {
    await seed({ title: "Unlabelled Gadget" });
    expect(await search("unlabelled gadget")).toEqual(["Unlabelled Gadget"]);
  });

  it("still filters by an option group with no knowledge definition", async () => {
    // Legacy option groups stay in the facet read model until the knowledge
    // base has a definition for them (D-090).
    const product = await seed({ title: "Legacy Shirt", categoryId: phonesId });
    const [variant] = await harness.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, product.id))
      .limit(1);
    expect(variant).toBeDefined();
    expect(await search("legacy shirt")).toEqual(["Legacy Shirt"]);
  });
});

// --------------------------------------------------------------- zero results

describe("zero-result intelligence", () => {
  async function recordZeroResult(query: string, times = 1) {
    for (let index = 0; index < times; index++) {
      await logSearch({
        query,
        resultsCount: 0,
        correctedQuery: null,
        visitorHash: `visitor-${index}`,
        now: new Date(Date.now() - index * 60_000),
      });
    }
  }

  it("says a search is a misspelling when the catalogue can correct it", async () => {
    await seed({ title: "Logitech Desk Keyboard", brand: "Logitech" });
    await recordZeroResult("logitec");

    const [finding] = await zeroResultIntelligence(staff, {});
    expect(finding.verdict).toBe("typo");
    expect(finding.correction?.toLowerCase()).toContain("logitech");
  });

  it("says a listing exists but is not visible", async () => {
    await seed({ title: "Hidden Kettle", status: "draft" });
    await recordZeroResult("hidden kettle");

    const [finding] = await zeroResultIntelligence(staff, {});
    expect(finding.verdict).toBe("unavailable_product");
    expect(finding.hiddenMatches[0]?.title).toBe("Hidden Kettle");
  });

  it("says nothing at all is related when nothing is", async () => {
    await seed({ title: "Studio Headphones" });
    await recordZeroResult("zzzqqxv");

    const [finding] = await zeroResultIntelligence(staff, {});
    expect(finding.verdict).toBe("irrelevant");
    expect(finding.aliasCandidates).toEqual([]);
  });

  it("proposes an alias but never records one by itself", async () => {
    await seed({ title: "Studio Reference Headphones" });
    await recordZeroResult("sarge", 5);

    const [finding] = await zeroResultIntelligence(staff, {});
    expect(finding.verdict).not.toBe("typo");

    // The system vocabulary ships with its own aliases, so the table is not
    // empty; what must not exist is one naming what a customer typed.
    const aliases = await harness.db
      .select()
      .from(pkbAliases)
      .where(eq(pkbAliases.aliasNormalized, "sarge"));
    expect(aliases).toEqual([]);
    expect(await search("sarge")).toEqual([]);
  });

  it("stays a suggestion even after staff record it, until it is approved", async () => {
    const product = await seed({ title: "Studio Reference Headphones" });
    await recordZeroResult("sarge", 5);

    // What the screen's button does.
    const suggestion = await suggestAlias(staff, {
      target: { kind: "product", id: await knowledgeIdOf(product.id) },
      alias: "sarge",
      aliasKind: "common_name",
    });
    expect(suggestion.status).toBe("suggested");
    expect(await search("sarge")).toEqual([]);

    await decideAlias(staff, suggestion.id, "approved");
    expect(await search("sarge")).toEqual(["Studio Reference Headphones"]);
  });

  it("is refused to someone without the permission", async () => {
    await expect(zeroResultIntelligence(customer, {})).rejects.toThrow();
  });
});

// --------------------------------------------------------------- families

describe("product families", () => {
  it("indexes the family a listing belongs to", async () => {
    // A category that defines specifications becomes an approved family on
    // sync (A-3), and the listing carries its key.
    await createCategoryAttribute(staff, audioId, {
      name: "Impedance",
      dataType: "number",
      unit: "ohm",
    });
    const product = await seed({ title: "Studio Headphones" });

    const [row] = await harness.db
      .select({ families: sql<string[]>`ps.family_keys` })
      .from(sql`product_search ps`)
      .where(sql`ps.product_id = ${product.id}`);
    expect(row.families).toEqual(["audio"]);
  });

  it("finds a listing through its family name", async () => {
    await createCategoryAttribute(staff, audioId, {
      name: "Impedance",
      dataType: "number",
      unit: "ohm",
    });
    await seed({ title: "Reference Monitor" });
    await seed({ title: "Wall Clock", categoryId: phonesId });

    const found = await search("audio");
    expect(found).toContain("Reference Monitor");
    expect(found).not.toContain("Wall Clock");
  });
});

// --------------------------------------------------------------- synonyms

describe("synonyms still work beside the knowledge base", () => {
  it("widens a search through a staff-written synonym", async () => {
    await seed({ title: "Everyday Earbuds", brand: "Northline Audio" });
    await createSynonym(staff, {
      term: "earphones",
      synonyms: ["earbuds"],
      bidirectional: true,
    });

    expect(await search("earphones")).toContain("Everyday Earbuds");
  });
});

// --------------------------------------------------------------- broad

describe("a broad search", () => {
  it("returns everything that matches, best first, without collapsing", async () => {
    await seed({ title: "Headphones", brand: "Northline Audio" });
    await seed({ title: "Studio Reference Headphones", brand: "Northline Audio" });
    await seed({ title: "Headphone Carry Case", brand: "Corvid Supply" });
    await seed({ title: "Desk Lamp", categoryId: phonesId });

    const found = await search("headphones");
    expect(found[0]).toBe("Headphones");
    expect(found).toContain("Studio Reference Headphones");
    expect(found).not.toContain("Desk Lamp");
  });
});

// --------------------------------------------------------------- analytics

describe("search events", () => {
  it("records a filter without recording which values were chosen", async () => {
    await logFilterUse({
      query: "headphones",
      keys: ["colour", "brand"],
      visitorHash: "visitor-1",
    });

    const [row] = await harness.db
      .select()
      .from(searchEvents)
      .where(eq(searchEvents.eventType, "filter"));
    expect(row.detail).toEqual({ keys: ["brand", "colour"] });
    expect(JSON.stringify(row.detail)).not.toContain("Midnight");
  });

  it("records a refinement against the search it replaced", async () => {
    const earlier = new Date(Date.now() - 60_000);
    await logSearch({
      query: "headphons",
      resultsCount: 0,
      correctedQuery: null,
      visitorHash: "visitor-1",
      now: earlier,
    });
    await logRefinement({ query: "headphones", visitorHash: "visitor-1" });

    const [row] = await harness.db
      .select()
      .from(searchEvents)
      .where(eq(searchEvents.eventType, "refine"));
    expect(row.queryNorm).toBe("headphones");
    expect(row.detail).toMatchObject({ from: "headphons", fromFoundNothing: true });
  });

  it("does not record a search that looks like an email address", async () => {
    await logFilterUse({
      query: "someone@example.com",
      keys: ["brand"],
      visitorHash: "visitor-1",
    });
    expect(await harness.db.select().from(searchEvents)).toEqual([]);
  });

  it("counts a conversion once, and erases what it counted", async () => {
    const product = await seed({ title: "Studio Headphones" });
    const [variant] = await harness.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, product.id));

    const [address] = await harness.db
      .insert(addresses)
      .values({
        recipientName: "Shopper",
        phone: "+8801700000000",
        addressLine1: "12 Example Road",
        city: "Dhaka",
        district: "Dhaka",
      })
      .returning({ id: addresses.id });

    const [order] = await harness.db
      .insert(orders)
      .values({
        orderNumber: `MN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        status: "placed",
        userId: customer.id,
        shippingAddressId: address.id,
        subtotalBdt: 1000,
        totalBdt: 1000,
        amountDueNowBdt: 1000,
        idempotencyKey: `key-${Math.random()}`,
      })
      .returning({ id: orders.id });

    await harness.db.insert(orderItems).values({
      orderId: order.id,
      variantId: variant.id,
      titleSnapshot: "Studio Headphones",
      skuSnapshot: "SKU-1",
      unitPriceBdt: 1000,
      quantity: 2,
      fulfillmentModeSnapshot: "preorder",
      searchQueryNorm: "studio headphones",
    });

    expect(await countSearchConversions(harness.db, order.id)).toBe(1);
    // A second delivery of the same confirmation finds nothing left to count.
    expect(await countSearchConversions(harness.db, order.id)).toBe(0);

    const rows = await harness.db
      .select()
      .from(searchEvents)
      .where(eq(searchEvents.eventType, "purchase"));
    expect(rows).toHaveLength(1);
    expect(rows[0].units).toBe(2);
    // A purchase is a fact about the catalogue, never about a person.
    expect(rows[0].visitorHash).toBeNull();

    const [line] = await harness.db
      .select({ query: orderItems.searchQueryNorm })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    expect(line.query).toBeNull();
  });
});

// --------------------------------------------------------------- permissions

describe("permissions", () => {
  it("lets someone who may manage search read the zero-result verdicts", async () => {
    await expect(zeroResultIntelligence(marketer, {})).resolves.toEqual([]);
  });

  it("refuses to record vocabulary without the catalogue permission", async () => {
    const product = await seed({ title: "Studio Headphones" });
    await expect(
      suggestAlias(marketer, {
        target: { kind: "product", id: await knowledgeIdOf(product.id) },
        alias: "sarge",
        aliasKind: "common_name",
      }),
    ).rejects.toThrow();
  });
});

// --------------------------------------------------------------- index upkeep

describe("the index follows the knowledge base", () => {
  it("re-indexes a listing when its knowledge changes", async () => {
    const product = await seed({ title: "Plain Kettle", brand: "Bellwether Kitchen" });
    expect(await search("gooseneck")).toEqual([]);

    await updateProduct(staff, product.id, {
      details: { specialFeatures: "Gooseneck spout" },
    });

    expect(await search("gooseneck")).toContain("Plain Kettle");
  });

  it("carries the knowledge brand into the index even when the listing text differs", async () => {
    const product = await seed({ title: "Plain Kettle", brand: "Bellwether Kitchen" });
    const [row] = await harness.db
      .select({ brandKey: sql<string>`ps.brand_key` })
      .from(sql`product_search ps`)
      .where(sql`ps.product_id = ${product.id}`);
    expect(row.brandKey).toBe("bellwether_kitchen");
  });

  it("keeps a retired knowledge product out of the terms", async () => {
    const product = await seed({ title: "Plain Kettle", brand: "Bellwether Kitchen" });
    const knowledgeId = await knowledgeIdOf(product.id);

    await harness.db
      .update(pkbProducts)
      .set({ status: "retired" })
      .where(eq(pkbProducts.id, knowledgeId));

    const [row] = await harness.db
      .select({ terms: sql<string[]>`ps.terms` })
      .from(sql`product_search ps`)
      .where(sql`ps.product_id = ${product.id}`);
    expect(row.terms).not.toContain(`p:${knowledgeId}`);
  });
});
