/**
 * Variant SKUs under real concurrency.
 *
 * A generated variant SKU starts with the first twelve letters of the product
 * slug. Two products whose names share that prefix, generating variants at the
 * same moment, both read the SKUs in use before either had inserted, chose the
 * same SKU, and one failed with "That already exists" — seen intermittently in
 * the end-to-end suite, where parallel tests create "Variant Test …" products.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productVariants, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct, createProductOption, generateVariants } from "@/lib/catalog";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;
let staff: SessionUser;

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("variant_sku_concurrency_test", 16);
  const [row] = await harness.db
    .insert(users)
    .values({ email: "sku@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id, email: users.email });
  staff = { id: row.id, email: row.email, role: "staff_admin" };
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
}, 60_000);

describe.skipIf(!available)("generating variants for similarly named products at once", () => {
  it("gives every variant its own SKU and fails none, over several rounds", async () => {
    const category = await createCategory(staff, { name: "Tests", slug: "tests" });

    for (let round = 0; round < 5; round += 1) {
      // Eight products whose slugs share the first twelve letters.
      const products = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          createProduct(staff, { title: `Variant Testing Round${round} ${index}`, categoryId: category.id }),
        ),
      );
      for (const product of products) {
        await createProductOption(staff, product.id, { name: "Flavor", values: ["Pumpkin Spice", "Peppermint"] });
      }

      const results = await Promise.allSettled(
        products.map((product) => generateVariants(staff, product.id, { priceBdt: 1_500_00 })),
      );
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    }

    const skus = (await harness.db.select({ sku: productVariants.sku }).from(productVariants)).map((row) => row.sku);
    expect(skus).toHaveLength(80);
    expect(new Set(skus).size).toBe(80);
  }, 120_000);
});

describe.skipIf(available)("variant SKU concurrency (skipped)", () => {
  it("needs the PostgreSQL server from `npm run db:server`", () => {
    expect(available).toBe(false);
  });
});
