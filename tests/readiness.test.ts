/**
 * Publish readiness.
 *
 * The wizard shows a checklist, but the checklist is not the rule — this is.
 * `publishProduct` re-runs every required check itself, so a stale wizard page,
 * a direct API call, or a future screen that forgets to look cannot put a
 * priceless, pictureless listing in front of a shopper.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productVariants, products, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  addProductImage,
  createCategory,
  createProduct,
  getReadiness,
  getReadinessSummary,
  NotReadyError,
  publishProduct,
} from "@/lib/catalog";
import {
  LocalMediaProvider,
  setMediaProviderForTesting,
} from "@/lib/providers/media";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let uploadDir = "";

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const customer: SessionUser = {
  id: "",
  email: "shopper@example.com",
  role: "customer",
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

let categoryId = "";

beforeAll(async () => {
  harness = await createTestDatabase();
  uploadDir = await mkdtemp(join(tmpdir(), "readiness-test-"));
  setMediaProviderForTesting(new LocalMediaProvider(uploadDir, "/uploads"));
}, 60_000);

afterAll(async () => {
  setMediaProviderForTesting(undefined);
  await rm(uploadDir, { recursive: true, force: true });
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

  staff.id = rows.find((r) => r.email === "staff@example.com")!.id;
  customer.id = rows.find((r) => r.email === "shopper@example.com")!.id;

  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await createCategory(staff, {
    name: `Cat ${suffix}`,
    slug: `cat-${suffix}`,
  });
  categoryId = category.id;
});

async function draftProduct() {
  return createProduct(staff, {
    title: `Product ${Math.random().toString(36).slice(2, 8)}`,
    categoryId,
    status: "draft",
  });
}

/** Everything a product needs to be publishable, one piece at a time. */
async function makeReady(productId: string) {
  await addProductImage(staff, productId, {
    data: PNG,
    originalName: "photo.png",
    contentType: "image/png",
    altText: "The product",
  });

  await harness.db.insert(productVariants).values({
    productId,
    sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
    priceBdt: 500_00,
    fulfillmentMode: "preorder",
    preorderCapacity: 20,
    preorderClosesAt: new Date(Date.now() + 86_400_000),
    estimatedArrivalFrom: new Date(Date.now() + 30 * 86_400_000),
  });
}

function check(checks: Awaited<ReturnType<typeof getReadiness>>, id: string) {
  return checks.find((entry) => entry.id === id)!;
}

describe("the checklist", () => {
  it("fails a bare draft on image, variant and price", async () => {
    const product = await draftProduct();
    const checks = await getReadiness(staff, product.id);

    expect(check(checks, "category").passed).toBe(true);
    expect(check(checks, "image").passed).toBe(false);
    expect(check(checks, "variant").passed).toBe(false);
    expect(check(checks, "price").passed).toBe(false);
  });

  it("passes once the product is actually finished", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    const summary = await getReadinessSummary(staff, product.id);
    expect(summary.canPublish).toBe(true);
  });

  /** A zero price would be charged as zero. */
  it("refuses a variant priced at nothing", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    await harness.db
      .update(productVariants)
      .set({ priceBdt: 0 })
      .where(eq(productVariants.productId, product.id));

    const checks = await getReadiness(staff, product.id);
    expect(check(checks, "price").passed).toBe(false);
  });

  /** An uncapped preorder is the overselling rule waiting to be broken. */
  it("refuses a preorder with no capacity or no closing date", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    await harness.db
      .update(productVariants)
      .set({ preorderCapacity: null })
      .where(eq(productVariants.productId, product.id));

    expect(check(await getReadiness(staff, product.id), "capacity").passed).toBe(
      false,
    );

    await harness.db
      .update(productVariants)
      .set({ preorderCapacity: 10, preorderClosesAt: null })
      .where(eq(productVariants.productId, product.id));

    expect(check(await getReadiness(staff, product.id), "capacity").passed).toBe(
      false,
    );
  });

  /**
   * There is deliberately no readiness check for this: the database refuses a
   * deposit variant with no percentage outright, so the state cannot exist to
   * be checked. Asserted here so the absence stays intentional.
   */
  it("cannot even store a deposit variant with no percentage", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    const refused = await harness.db
      .update(productVariants)
      .set({ paymentMode: "deposit", depositPercent: null })
      .where(eq(productVariants.productId, product.id))
      .then(() => null)
      .catch((error: unknown) => error);

    // Drizzle wraps driver errors, so the constraint name is on the cause.
    expect(String((refused as Error)?.cause)).toContain(
      "deposit_requires_percent",
    );
  });

  /** A disabled variant is not on sale, so it is not what publishing is about. */
  it("ignores disabled variants", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    await harness.db
      .update(productVariants)
      .set({ isEnabled: false })
      .where(eq(productVariants.productId, product.id));

    const checks = await getReadiness(staff, product.id);
    expect(check(checks, "variant").passed).toBe(false);
  });

  it("separates advice from requirements", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    const summary = await getReadinessSummary(staff, product.id);

    // No description and no meta description: worth saying, not worth blocking.
    expect(summary.canPublish).toBe(true);
    expect(summary.warnings.length).toBeGreaterThan(0);
  });

  it("refuses a customer", async () => {
    const product = await draftProduct();

    await expect(getReadiness(customer, product.id)).rejects.toThrow(
      AuthorizationError,
    );
  });
});

describe("publishing", () => {
  it("refuses an unfinished product and says why", async () => {
    const product = await draftProduct();

    await expect(
      publishProduct(staff, product.id, "preorder_open"),
    ).rejects.toThrow(NotReadyError);

    // Still a draft: a refused publish changes nothing.
    const [row] = await harness.db
      .select({ status: products.status })
      .from(products)
      .where(eq(products.id, product.id));

    expect(row.status).toBe("draft");
  });

  it("names every failure rather than only the first", async () => {
    const product = await draftProduct();

    await expect(
      publishProduct(staff, product.id, "preorder_open"),
    ).rejects.toThrow(/photograph/);
    await expect(
      publishProduct(staff, product.id, "preorder_open"),
    ).rejects.toThrow(/something to buy/);
  });

  it("publishes a finished product", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    const published = await publishProduct(staff, product.id, "preorder_open");
    expect(published.status).toBe("preorder_open");
  });

  /** Publishing is not a way to set an arbitrary status. */
  it("refuses a status shoppers cannot see", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    await expect(
      publishProduct(staff, product.id, "draft"),
    ).rejects.toThrow(NotReadyError);
  });

  it("refuses a customer", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    await expect(
      publishProduct(customer, product.id, "preorder_open"),
    ).rejects.toThrow(AuthorizationError);
  });

  it("brings an archived product back when it is republished", async () => {
    const product = await draftProduct();
    await makeReady(product.id);

    await harness.db
      .update(products)
      .set({ archivedAt: new Date() })
      .where(eq(products.id, product.id));

    await publishProduct(staff, product.id, "preorder_open");

    const [row] = await harness.db
      .select({ archivedAt: products.archivedAt })
      .from(products)
      .where(eq(products.id, product.id));

    expect(row.archivedAt).toBeNull();
  });
});
