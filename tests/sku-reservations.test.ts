/**
 * The SKU lifecycle (DECISIONS.md D-037): reserved for an unsaved Add Product
 * form, finalized (permanent) when the product is saved, released when the
 * form is abandoned or its hold expires. Released SKUs come back into use;
 * permanent ones never do.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLog, categories, products, skuReservations, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { archiveProduct, createProduct, updateProduct } from "@/lib/catalog";
import {
  defaultSkuStrategy,
  releaseExpiredSkuReservations,
  releaseSkuReservation,
  reserveSku,
} from "@/lib/catalog/sku";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staffA: SessionUser = { id: "", email: "a@example.com", role: "product_manager" };
const staffB: SessionUser = { id: "", email: "b@example.com", role: "staff_admin" };
const support: SessionUser = { id: "", email: "support@example.com", role: "support" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };
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
      { email: staffA.email, passwordHash: "x", role: "product_manager" },
      { email: staffB.email, passwordHash: "x", role: "staff_admin" },
      { email: support.email, passwordHash: "x", role: "support" },
      { email: customer.email, passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  for (const actor of [staffA, staffB, support, customer]) {
    actor.id = rows.find((row) => row.email === actor.email)!.id;
  }
  const [category] = await harness.db
    .insert(categories)
    .values({ name: "Audio", slug: "audio" })
    .returning({ id: categories.id });
  categoryId = category.id;
});

const statusOf = async (id: string) =>
  (await harness.db.select().from(skuReservations).where(eq(skuReservations.id, id)))[0];

const newProduct = (title: string, extra: Record<string, unknown> = {}) =>
  createProduct(staffA, { title, categoryId, ...extra } as never);

describe("generation", () => {
  it("produces a valid SKU in the configured format", async () => {
    const hold = await reserveSku(staffA);
    expect(hold.sku).toBe("SKU-000001");
    expect(defaultSkuStrategy.parse(hold.sku)).toBe(1);
  });

  it("skips SKUs already on a product", async () => {
    await harness.db.insert(products).values({ title: "Old", slug: "old", categoryId, sku: "SKU-000001" });
    expect((await reserveSku(staffA)).sku).toBe("SKU-000002");
  });

  it("never hands out a SKU another form is holding", async () => {
    const first = await reserveSku(staffA);
    const second = await reserveSku(staffB);
    expect(second.sku).not.toBe(first.sku);
  });

  it("gives two simultaneous requests different SKUs", async () => {
    const holds = await Promise.all([reserveSku(staffA), reserveSku(staffB), reserveSku(staffA)]);
    expect(new Set(holds.map((hold) => hold.sku)).size).toBe(3);
  });

  it("is refused to customers and to roles without catalogue access", async () => {
    await expect(reserveSku(customer)).rejects.toThrow();
    await expect(reserveSku(support)).rejects.toThrow();
    await expect(reserveSku(null)).rejects.toThrow();
  });
});

describe("reservation", () => {
  it("renews the same SKU when the same form comes back", async () => {
    const first = await reserveSku(staffA);
    const again = await reserveSku(staffA, { reservationId: first.id });
    expect(again).toMatchObject({ id: first.id, sku: first.sku, renewed: true });
  });

  it("does not let another admin take over someone's hold", async () => {
    const first = await reserveSku(staffA);
    const other = await reserveSku(staffB, { reservationId: first.id });
    expect(other.id).not.toBe(first.id);
    expect(other.sku).not.toBe(first.sku);
    await expect(releaseSkuReservation(staffB, first.id)).resolves.toBe(false);
    expect((await statusOf(first.id)).status).toBe("reserved");
  });

  it("releases an abandoned form's SKU, which is then reused", async () => {
    const first = await reserveSku(staffA);
    await expect(releaseSkuReservation(staffA, first.id)).resolves.toBe(true);
    expect((await statusOf(first.id)).status).toBe("released");
    expect((await reserveSku(staffB)).sku).toBe(first.sku);
  });

  it("expires a stale hold so its SKU returns to use", async () => {
    const first = await reserveSku(staffA);
    await harness.db
      .update(skuReservations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(skuReservations.id, first.id));
    expect(await releaseExpiredSkuReservations()).toBe(1);
    expect((await statusOf(first.id)).status).toBe("released");
    expect((await reserveSku(staffB)).sku).toBe(first.sku);
  });

  it("audits reserve and release", async () => {
    const first = await reserveSku(staffA);
    await releaseSkuReservation(staffA, first.id);
    const actions = (await harness.db.select({ action: auditLog.action }).from(auditLog)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["sku.reserved", "sku.released"]));
  });
});

describe("finalization", () => {
  it("makes the held SKU the product's, permanently", async () => {
    const hold = await reserveSku(staffA);
    const product = await newProduct("Headphones", { sku: hold.sku, skuReservationId: hold.id });
    expect(product.sku).toBe(hold.sku);
    const row = await statusOf(hold.id);
    expect(row).toMatchObject({ status: "finalized", productId: product.id });
  });

  it("uses the held SKU when the form sends none of its own", async () => {
    const hold = await reserveSku(staffA);
    const product = await newProduct("No SKU typed", { skuReservationId: hold.id });
    expect(product.sku).toBeNull();
    expect((await statusOf(hold.id)).status).toBe("released");
  });

  it("never generates a permanent SKU again — even after archiving", async () => {
    const hold = await reserveSku(staffA);
    const product = await newProduct("Kept", { sku: hold.sku, skuReservationId: hold.id });
    await archiveProduct(staffA, product.id);
    expect((await reserveSku(staffB)).sku).not.toBe(hold.sku);
  });

  it("keeps a SKU spent after the product's SKU is changed", async () => {
    const hold = await reserveSku(staffA);
    const product = await newProduct("Renamed", { sku: hold.sku, skuReservationId: hold.id });
    await updateProduct(staffA, product.id, { sku: "CUSTOM-1", slug: "renamed" } as never);
    expect((await reserveSku(staffB)).sku).not.toBe(hold.sku);
    await expect(newProduct("Thief", { sku: hold.sku })).rejects.toThrow(/cannot be reused|already/);
  });

  it("with a typed SKU, releases the hold and records the typed one as permanent", async () => {
    const hold = await reserveSku(staffA);
    const product = await newProduct("Typed", { sku: "MY-OWN-7", skuReservationId: hold.id });
    expect(product.sku).toBe("MY-OWN-7");
    expect((await statusOf(hold.id)).status).toBe("released");
    const permanent = await harness.db.select().from(skuReservations).where(eq(skuReservations.sku, "MY-OWN-7"));
    expect(permanent[0]).toMatchObject({ status: "finalized", productId: product.id });
  });

  it("refuses a SKU another admin's form is holding", async () => {
    const theirs = await reserveSku(staffB);
    await expect(newProduct("Clash", { sku: theirs.sku })).rejects.toThrow(/held for another/);
  });
});

describe("failure", () => {
  it("leaves the hold intact when the product fails to save, so a retry works", async () => {
    const hold = await reserveSku(staffA);
    // A slug taken by another product makes the insert fail inside the transaction.
    await harness.db.insert(products).values({ title: "Taken", slug: "taken", categoryId });
    await expect(
      newProduct("Retry me", { sku: hold.sku, skuReservationId: hold.id, slug: "taken" }),
    ).rejects.toThrow();
    expect((await statusOf(hold.id)).status).toBe("reserved");
    const retried = await newProduct("Retry me", { sku: hold.sku, skuReservationId: hold.id });
    expect(retried.sku).toBe(hold.sku);
    expect((await statusOf(hold.id)).status).toBe("finalized");
  });

  it("the database refuses two holds on one SKU", async () => {
    const hold = await reserveSku(staffA);
    await expect(
      harness.db.execute(
        sql`insert into sku_reservations (sku, reserved_by, expires_at) values (${hold.sku}, ${staffB.id}, now() + interval '1 hour')`,
      ),
    ).rejects.toThrow();
  });
});
