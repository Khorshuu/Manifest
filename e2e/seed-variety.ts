import { taka } from "../lib/money";
import * as schema from "../db/schema";
import type { SeedDatabase } from "../db/seed";

const { categories, products, productVariants } = schema;

/**
 * Listings the development seed does not have, added to the end-to-end
 * database only (e2e/prepare-db.ts), never to a developer's catalogue.
 *
 * The development seed is all open preorders. The storefront also sells from
 * stock, runs out, shows a listing staff have not finished, and has to cope
 * with a title far longer than any seeded one. Each listing below exists for
 * one of those cases, and `e2e/catalog-variety.spec.ts` is what asserts on
 * them. They live on their own shelf, so no existing spec's counts move.
 *
 * Deterministic: fixed titles, slugs, SKUs and quantities; dates relative to
 * the run, as the development seed's are.
 */
export const VARIETY = {
  shelf: { name: "Stationery", slug: "stationery" },
  inStock: { title: "Dotted Grid Notebook, A5", slug: "dotted-grid-notebook-a5", sku: "E2E-NOTEBOOK-A5", stock: 40 },
  outOfStock: { title: "Brass Fountain Pen, Fine Nib", slug: "brass-fountain-pen-fine-nib", sku: "E2E-PEN-BRASS" },
  lowStock: { title: "Archival Ink Cartridges, 12-Pack", slug: "archival-ink-cartridges-12-pack", sku: "E2E-INK-12", stock: 2 },
  longTitle: {
    title:
      "Heavyweight Recycled Kraft Paper Sketchbook with Lay-Flat Binding, 120 Sheets of 160 gsm Acid-Free Paper for Ink, Marker and Light Watercolour",
    slug: "heavyweight-recycled-kraft-sketchbook",
    sku: "E2E-SKETCH-KRAFT",
  },
  sparse: { title: "Plain Desk Blotter", slug: "plain-desk-blotter", sku: "E2E-BLOTTER" },
  draft: { title: "Unreleased Weekly Planner", slug: "unreleased-weekly-planner", sku: "E2E-PLANNER-DRAFT" },
} as const;

const DAY = 24 * 60 * 60 * 1000;

export async function seedVariety(db: SeedDatabase) {
  const [shelf] = await db
    .insert(categories)
    .values({ name: VARIETY.shelf.name, slug: VARIETY.shelf.slug, sortOrder: 9 })
    .returning();

  const listing = (entry: { title: string; slug: string }, extra: Partial<typeof products.$inferInsert> = {}) => ({
    categoryId: shelf.id,
    title: entry.title,
    slug: entry.slug,
    brand: "Fieldnote Paper Co.",
    descriptionHtml: `<p>${entry.title}, sold from stock in Dhaka.</p>`,
    bulletFeatures: ["Acid-free paper", "Made in small batches", "Ships from stock on hand"],
    specTable: [{ label: "Origin", value: "United States" }],
    status: "in_stock" as const,
    ...extra,
  });

  const [inStock, outOfStock, lowStock, longTitle, sparse, draft] = await db
    .insert(products)
    .values([
      listing(VARIETY.inStock),
      listing(VARIETY.outOfStock),
      listing(VARIETY.lowStock),
      listing(VARIETY.longTitle, { status: "preorder_open" }),
      // Nothing optional: no brand, no features, no specifications.
      { categoryId: shelf.id, title: VARIETY.sparse.title, slug: VARIETY.sparse.slug, descriptionHtml: "<p>A plain desk blotter.</p>", status: "in_stock" as const },
      listing(VARIETY.draft, { status: "draft" }),
    ])
    .returning();

  const fromStock = (productId: string, sku: string, price: number, stockQuantity: number, extra: Partial<typeof productVariants.$inferInsert> = {}) => ({
    productId,
    sku,
    priceBdt: taka(price),
    costPriceUsd: Math.round((price * 0.55) / 120) * 100,
    weightGrams: 300,
    fulfillmentMode: "in_stock" as const,
    stockQuantity,
    paymentMode: "full" as const,
    ...extra,
  });

  await db.insert(productVariants).values([
    fromStock(inStock.id, VARIETY.inStock.sku, 950, VARIETY.inStock.stock),
    fromStock(outOfStock.id, VARIETY.outOfStock.sku, 4200, 0),
    // On sale, and at or below its low-stock line.
    fromStock(lowStock.id, VARIETY.lowStock.sku, 1400, VARIETY.lowStock.stock, { salePriceBdt: taka(1150), lowStockThreshold: 5 }),
    {
      productId: longTitle.id,
      sku: VARIETY.longTitle.sku,
      priceBdt: taka(2600),
      costPriceUsd: 1200,
      weightGrams: 900,
      fulfillmentMode: "preorder" as const,
      preorderCapacity: 30,
      preorderClosesAt: new Date(Date.now() + 20 * DAY),
      estimatedArrivalFrom: new Date(Date.now() + 41 * DAY),
      estimatedArrivalTo: new Date(Date.now() + 55 * DAY),
      // A deposit listing: the rest is paid on arrival.
      paymentMode: "deposit" as const,
      depositPercent: 30,
    },
    fromStock(sparse.id, VARIETY.sparse.sku, 700, 10),
    fromStock(draft.id, VARIETY.draft.sku, 1800, 25),
  ]);

  process.stdout.write("End-to-end variety listings added: 6 (stock, out of stock, low stock on sale, long title with deposit, sparse, draft)\n");
}
