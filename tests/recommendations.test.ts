/**
 * What "you may also like" is allowed to mean.
 *
 * The rule the brief states plainly is that a recommendation must never be a
 * random product. So each signal is asserted on its own — a stated
 * relationship, a shelf, a tag, a brand — and the fallback is asserted to be a
 * fallback rather than a shuffle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productRelated, productVariants, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  createCategory,
  createProduct,
  listRecommendations,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};

let coffeeId = "";
let toolsId = "";

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();

  const [user] = await harness.db
    .insert(users)
    .values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = user.id;

  coffeeId = (await createCategory(staff, { name: "Coffee", slug: "coffee" })).id;
  toolsId = (await createCategory(staff, { name: "Tools", slug: "tools" })).id;
});

async function seed(options: {
  title: string;
  categoryId: string;
  brand?: string;
  tags?: string[];
  priceBdt?: number;
}) {
  const product = await createProduct(staff, {
    title: options.title,
    categoryId: options.categoryId,
    brand: options.brand,
    tags: options.tags,
    status: "preorder_open",
  });

  await harness.db.insert(productVariants).values({
    productId: product.id,
    sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
    priceBdt: options.priceBdt ?? 2_000_00,
    fulfillmentMode: "preorder",
    preorderClosesAt: new Date(Date.now() + 86_400_000),
  });

  return product;
}

describe("recommendations", () => {
  it("never recommends the product being looked at", async () => {
    const subject = await seed({ title: "Pour-over Kettle", categoryId: coffeeId });
    await seed({ title: "Coffee Grinder", categoryId: coffeeId });

    const recommended = await listRecommendations(subject.id, 4);
    expect(recommended.map((card) => card.id)).not.toContain(subject.id);
  });

  it("puts a relationship staff stated above everything else", async () => {
    const subject = await seed({ title: "Pour-over Kettle", categoryId: coffeeId });
    // Same shelf, same brand, shared tag — the strongest automatic score there
    // is, and still second to a person's decision.
    await seed({
      title: "Coffee Grinder",
      categoryId: coffeeId,
      brand: "Bellwether",
      tags: ["coffee"],
    });
    const stated = await seed({ title: "Bench Vice", categoryId: toolsId });

    await harness.db.insert(productRelated).values({
      productId: subject.id,
      relatedProductId: stated.id,
      kind: "related",
    });

    const recommended = await listRecommendations(subject.id, 4);
    expect(recommended[0].title).toBe("Bench Vice");
  });

  it("prefers the same shelf to another one", async () => {
    const subject = await seed({ title: "Pour-over Kettle", categoryId: coffeeId });
    await seed({ title: "Bench Vice", categoryId: toolsId });
    await seed({ title: "Coffee Grinder", categoryId: coffeeId });

    const recommended = await listRecommendations(subject.id, 1);
    expect(recommended[0].title).toBe("Coffee Grinder");
  });

  it("counts a shared tag even across shelves", async () => {
    const subject = await seed({
      title: "Pour-over Kettle",
      categoryId: coffeeId,
      tags: ["gift"],
    });
    await seed({ title: "Plain Hammer", categoryId: toolsId });
    await seed({ title: "Gift Wrap Set", categoryId: toolsId, tags: ["gift"] });

    const recommended = await listRecommendations(subject.id, 1);
    expect(recommended[0].title).toBe("Gift Wrap Set");
  });

  it("counts a shared brand", async () => {
    const subject = await seed({
      title: "Pour-over Kettle",
      categoryId: coffeeId,
      brand: "Bellwether",
    });
    await seed({ title: "Plain Hammer", categoryId: toolsId });
    await seed({ title: "Bench Vice", categoryId: toolsId, brand: "Bellwether" });

    const recommended = await listRecommendations(subject.id, 1);
    expect(recommended[0].title).toBe("Bench Vice");
  });

  it("tops the row up when too little scores, rather than leaving a gap", async () => {
    const subject = await seed({ title: "Pour-over Kettle", categoryId: coffeeId });
    await seed({ title: "Plain Hammer", categoryId: toolsId });
    await seed({ title: "Bench Vice", categoryId: toolsId });

    // Nothing shares a shelf, a brand or a tag with the subject, so nothing
    // scores — and the row still fills, from what the shop actually has.
    const recommended = await listRecommendations(subject.id, 4);
    expect(recommended).toHaveLength(2);
    expect(recommended.map((card) => card.id)).not.toContain(subject.id);
  });

  it("says nothing at all when the catalogue holds nothing else", async () => {
    const subject = await seed({ title: "Pour-over Kettle", categoryId: coffeeId });

    expect(await listRecommendations(subject.id, 4)).toEqual([]);
  });

  it("cannot recommend a draft", async () => {
    const subject = await seed({ title: "Pour-over Kettle", categoryId: coffeeId });
    await createProduct(staff, {
      title: "Unpublished Grinder",
      categoryId: coffeeId,
      status: "draft",
    });

    expect(await listRecommendations(subject.id, 4)).toEqual([]);
  });
});
