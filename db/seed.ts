/**
 * Development seed data. Idempotent: it clears the tables it owns, then
 * re-inserts, so it can be run repeatedly against a local database.
 *
 * Run with: npm run db:seed
 */
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
/* eslint-disable @typescript-eslint/no-explicit-any -- the schema generic is
   intentionally open so both the postgres-js and PGlite databases satisfy it */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { taka } from "../lib/money";

const {
  attributes,
  attributeValues,
  categories,
  productAttributes,
  productImages,
  products,
  productVariants,
  siteSettings,
  users,
  variantOptionValues,
} = schema;

/**
 * Any Drizzle Postgres database: postgres-js in development, PGlite in tests.
 * The schema generic is deliberately left off — the seed only uses insert and
 * execute, so constraining it further would reject a caller for no reason.
 */
export type SeedDatabase = PgDatabase<PgQueryResultHKT, any>;

export async function seed(db: SeedDatabase) {
  console.log("Clearing seeded tables...");
  await db.execute(sql`
    truncate table
      variant_option_values, variant_images, waitlist_entries,
      inventory_adjustments, product_attributes, product_variants,
      product_images, product_related, product_categories, products,
      categories, attribute_values, attributes, site_settings, users
    restart identity cascade
  `);

  console.log("Seeding users...");
  const passwordHash = await hash("password123");
  const [superAdmin, staffAdmin, customer] = await db
    .insert(users)
    .values([
      {
        email: "admin@example.com",
        phone: "+8801700000001",
        passwordHash,
        role: "super_admin",
        emailVerifiedAt: new Date(),
      },
      {
        email: "staff@example.com",
        phone: "+8801700000002",
        passwordHash,
        role: "staff_admin",
        emailVerifiedAt: new Date(),
      },
      {
        email: "customer@example.com",
        phone: "+8801700000003",
        passwordHash,
        role: "customer",
        emailVerifiedAt: new Date(),
      },
    ])
    .returning();

  console.log("Seeding category tree (3 levels)...");
  const [snacks, electronics] = await db
    .insert(categories)
    .values([
      { name: "Snacks & Groceries", slug: "snacks-groceries", sortOrder: 1 },
      { name: "Electronics", slug: "electronics", sortOrder: 2 },
    ])
    .returning();

  const [candy, headphones] = await db
    .insert(categories)
    .values([
      {
        name: "Candy & Chocolate",
        slug: "candy-chocolate",
        parentId: snacks.id,
        sortOrder: 1,
      },
      {
        name: "Audio",
        slug: "audio",
        parentId: electronics.id,
        sortOrder: 1,
      },
    ])
    .returning();

  const [seasonalCandy, overEar] = await db
    .insert(categories)
    .values([
      {
        name: "Seasonal & Limited Edition",
        slug: "seasonal-limited-edition",
        parentId: candy.id,
        sortOrder: 1,
      },
      {
        name: "Over-ear Headphones",
        slug: "over-ear-headphones",
        parentId: headphones.id,
        sortOrder: 1,
      },
    ])
    .returning();

  console.log("Seeding attributes...");
  const [flavor, color] = await db
    .insert(attributes)
    .values([
      { name: "Flavor", inputType: "select" },
      { name: "Color", inputType: "select" },
    ])
    .returning();

  const flavorValues = await db
    .insert(attributeValues)
    .values([
      { attributeId: flavor.id, value: "Pumpkin Spice", sortOrder: 1 },
      { attributeId: flavor.id, value: "Peppermint", sortOrder: 2 },
    ])
    .returning();

  const colorValues = await db
    .insert(attributeValues)
    .values([
      { attributeId: color.id, value: "Midnight Black", sortOrder: 1 },
      { attributeId: color.id, value: "Sandstone", sortOrder: 2 },
    ])
    .returning();

  console.log("Seeding products...");
  const closesAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const arrivalFrom = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);
  const arrivalTo = new Date(Date.now() + 49 * 24 * 60 * 60 * 1000);

  const [candyProduct, headphoneProduct] = await db
    .insert(products)
    .values([
      {
        categoryId: seasonalCandy.id,
        title: "Seasonal Candy Variety Box",
        slug: "seasonal-candy-variety-box",
        brand: "Hometown Confectionery",
        descriptionHtml:
          "<p>A limited-run seasonal box, sold in the US only and not distributed in Bangladesh.</p>",
        bulletFeatures: [
          "Limited seasonal run, sourced direct from the US",
          "Arrives sealed in original retail packaging",
          "Fixed landed price — shipping and duty already included",
        ],
        specTable: [
          { label: "Net weight", value: "680 g" },
          { label: "Origin", value: "United States" },
        ],
        tags: ["seasonal", "limited"],
        seoMetaTitle: "Seasonal Candy Variety Box — preorder from the US",
        seoMetaDescription:
          "Preorder a limited seasonal US candy box, delivered in Bangladesh at a fixed landed price.",
        status: "preorder_open",
      },
      {
        categoryId: overEar.id,
        title: "Studio Reference Headphones",
        slug: "studio-reference-headphones",
        brand: "Northline Audio",
        descriptionHtml:
          "<p>Open-back reference headphones, hard to source locally and heavily marked up when they do appear.</p>",
        bulletFeatures: [
          "Open-back, 250 ohm reference drivers",
          "Two-year manufacturer warranty honoured through us",
          "Fixed landed price — shipping and duty already included",
        ],
        specTable: [
          { label: "Impedance", value: "250 ohm" },
          { label: "Weight", value: "295 g" },
          { label: "Origin", value: "United States" },
        ],
        tags: ["audio", "preorder"],
        seoMetaTitle: "Studio Reference Headphones — preorder from the US",
        seoMetaDescription:
          "Preorder open-back studio reference headphones from the US, delivered in Bangladesh.",
        status: "preorder_open",
      },
    ])
    .returning();

  await db.insert(productImages).values([
    {
      productId: candyProduct.id,
      url: "/seed/candy-box.svg",
      altText: "Seasonal candy variety box in its retail packaging",
      sortOrder: 0,
    },
    {
      productId: headphoneProduct.id,
      url: "/seed/headphones.svg",
      altText: "Open-back studio reference headphones, three-quarter view",
      sortOrder: 0,
    },
  ]);

  await db.insert(productAttributes).values([
    { productId: candyProduct.id, attributeId: flavor.id, sortOrder: 0 },
    { productId: headphoneProduct.id, attributeId: color.id, sortOrder: 0 },
  ]);

  console.log("Seeding variants...");
  const candyVariants = await db
    .insert(productVariants)
    .values(
      flavorValues.map((_value, i) => ({
        productId: candyProduct.id,
        sku: `CANDY-BOX-${i + 1}`,
        priceBdt: taka(1850),
        costPriceUsd: 1200,
        weightGrams: 680,
        fulfillmentMode: "preorder" as const,
        preorderCapacity: 40,
        preorderReserved: i === 0 ? 12 : 0,
        preorderClosesAt: closesAt,
        estimatedArrivalFrom: arrivalFrom,
        estimatedArrivalTo: arrivalTo,
        paymentMode: "full" as const,
      })),
    )
    .returning();

  const headphoneVariants = await db
    .insert(productVariants)
    .values(
      colorValues.map((_value, i) => ({
        productId: headphoneProduct.id,
        sku: `NL-STUDIO-${i + 1}`,
        priceBdt: taka(31500),
        costPriceUsd: 21000,
        weightGrams: 295,
        fulfillmentMode: "preorder" as const,
        preorderCapacity: 10,
        preorderReserved: i === 1 ? 10 : 3,
        preorderClosesAt: closesAt,
        estimatedArrivalFrom: arrivalFrom,
        estimatedArrivalTo: arrivalTo,
        paymentMode: "deposit" as const,
        depositPercent: 40,
      })),
    )
    .returning();

  await db.insert(variantOptionValues).values([
    ...candyVariants.map((variant, i) => ({
      variantId: variant.id,
      attributeId: flavor.id,
      attributeValueId: flavorValues[i].id,
    })),
    ...headphoneVariants.map((variant, i) => ({
      variantId: variant.id,
      attributeId: color.id,
      attributeValueId: colorValues[i].id,
    })),
  ]);

  console.log("Seeding site settings...");
  await db.insert(siteSettings).values([
    {
      key: "store.contact_email",
      valueJson: { value: "hello@example.com" },
      updatedBy: superAdmin.id,
    },
    {
      key: "preorder.default_deposit_percent",
      valueJson: { value: 40 },
      updatedBy: superAdmin.id,
    },
  ]);

  console.log(
    [
      "",
      "Seed complete:",
      `  users              3 (${superAdmin.email} / ${staffAdmin.email} / ${customer.email}, password: password123)`,
      "  categories         6 (3 levels deep)",
      "  attributes         2 with 4 values",
      "  products           2, both preorder_open",
      `  variants           ${candyVariants.length + headphoneVariants.length} (one is deliberately at full capacity, to exercise the waitlist path)`,
      "",
    ].join("\n"),
  );

  return {
    users: 3,
    categories: 6,
    products: 2,
    variants: candyVariants.length + headphoneVariants.length,
  };
}
