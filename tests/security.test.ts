/**
 * A pass over docs/SECURITY.md, written as probes rather than happy paths.
 *
 * Each test tries to do the thing the document forbids, and asserts that it
 * fails. A rule nobody has attempted to break is not a verified rule.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  auditLog,
  orders,
  productVariants,
  users,
} from "@/db/schema";
import { anonymiseCustomer, AnonymisationError } from "@/lib/auth";
import { AuthorizationError } from "@/lib/auth/authorize";
import { createSession, validateSessionToken } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/session";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import {
  archiveProduct,
  createCategory,
  createProduct,
  getPublicProductBySlug,
  getPublicVariants,
  updateVariant,
} from "@/lib/catalog";
import { getGuestOrder, placeOrder } from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from "@/lib/providers/payment";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const superAdmin: SessionUser = {
  id: "",
  email: "admin@example.com",
  role: "super_admin",
};
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

let addressId = "";

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  setPaymentProviderForTesting(new MockPaymentProvider());

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "admin@example.com", passwordHash: "x", role: "super_admin" },
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  superAdmin.id = rows.find((r) => r.email === "admin@example.com")!.id;
  staff.id = rows.find((r) => r.email === "staff@example.com")!.id;
  customer.id = rows.find((r) => r.email === "shopper@example.com")!.id;

  const [address] = await harness.db
    .insert(addresses)
    .values({
      userId: customer.id,
      recipientName: "A Shopper",
      phone: "+8801700000000",
      addressLine1: "12 Example Road",
      city: "Dhaka",
      district: "Dhaka",
    })
    .returning({ id: addresses.id });

  addressId = address.id;
});

async function seedProduct(overrides: { costPriceUsd?: number } = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await createCategory(staff, {
    name: `Cat ${suffix}`,
    slug: `cat-${suffix}`,
  });
  const product = await createProduct(staff, {
    title: `Product ${suffix}`,
    categoryId: category.id,
    status: "preorder_open",
  });

  const [variant] = await harness.db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `SKU-${suffix}`,
      priceBdt: 500_00,
      costPriceUsd: overrides.costPriceUsd ?? 1_000,
      fulfillmentMode: "preorder",
      preorderCapacity: 20,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  return { product, variant };
}

describe("the sourcing cost never reaches a shopper", () => {
  it("is absent from the public product query", async () => {
    const { product } = await seedProduct({ costPriceUsd: 4_242 });

    const publicProduct = await getPublicProductBySlug(product.slug);
    expect(JSON.stringify(publicProduct)).not.toContain("4242");
    expect(JSON.stringify(publicProduct)).not.toMatch(/cost/i);
  });

  it("is absent from the public variant query", async () => {
    const { product } = await seedProduct({ costPriceUsd: 4_242 });

    const variants = await getPublicVariants(product.id);
    expect(JSON.stringify(variants)).not.toContain("4242");
    expect(JSON.stringify(variants)).not.toMatch(/costPrice/i);
  });
});

describe("a customer cannot reach staff capability", () => {
  it("cannot create a product", async () => {
    const category = await createCategory(staff, {
      name: "Gated",
      slug: "gated",
    });

    await expect(
      createProduct(customer, { title: "Sneaky", categoryId: category.id }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("cannot change a price", async () => {
    const { variant } = await seedProduct();

    await expect(
      updateVariant(customer, variant.id, { priceBdt: 1 }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("cannot archive a product", async () => {
    const { product } = await seedProduct();

    await expect(archiveProduct(customer, product.id)).rejects.toThrow(
      AuthorizationError,
    );
  });

  /** An anonymous caller is unauthenticated, which is a different answer. */
  it("an anonymous caller is refused too", async () => {
    const { variant } = await seedProduct();
    await expect(updateVariant(null, variant.id, { priceBdt: 1 })).rejects.toThrow();
  });
});

describe("sessions", () => {
  it("stores no value that could be replayed", async () => {
    const { token } = await createSession(customer.id);

    const rows = await harness.client.query<{ id: string }>(
      "select id from sessions",
    );

    expect(rows.rows[0].id).not.toBe(token);
    expect(rows.rows[0].id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a made-up token resolves to nothing", async () => {
    await expect(validateSessionToken("not-a-real-token")).resolves.toBeNull();
  });
});

describe("guest order lookup", () => {
  async function placeGuestOrder(email: string) {
    const { variant } = await seedProduct();
    const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
    await addToCart(cartId, variant.id, 1);

    return placeOrder({
      cartId,
      userId: null,
      guestEmail: email,
      guestPhone: null,
      shippingAddressId: addressId,
      method: "card",
      idempotencyKey: `key-${Math.random()}`,
    });
  }

  /** An order number is guessable; on its own it must reveal nothing. */
  it("needs the email as well as the order number", async () => {
    const placed = await placeGuestOrder("first@example.com");

    await expect(
      getGuestOrder(placed.orderNumber, "attacker@example.com"),
    ).resolves.toBeNull();

    await expect(
      getGuestOrder(placed.orderNumber, "first@example.com"),
    ).resolves.not.toBeNull();
  });

  it("carries no internal notes", async () => {
    const placed = await placeGuestOrder("first@example.com");

    await harness.db
      .update(orders)
      .set({ internalNotes: "staff-only-marker" })
      .where(eq(orders.id, placed.orderId));

    const view = await getGuestOrder(placed.orderNumber, "first@example.com");
    expect(JSON.stringify(view)).not.toContain("staff-only-marker");
  });
});

describe("the audit log is append-only from the application", () => {
  it("exposes no function that updates or deletes an entry", async () => {
    const auditModule = await import("@/lib/admin/audit");
    const names = Object.keys(auditModule);

    expect(names.some((name) => /update|delete|remove/i.test(name))).toBe(
      false,
    );
  });

  it("records the actor on every entry", async () => {
    await seedProduct();

    const entries = await harness.db.select().from(auditLog);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.actorUserId !== null)).toBe(true);
  });
});

describe("anonymising a customer", () => {
  it("refuses a staff admin", async () => {
    await expect(anonymiseCustomer(staff, customer.id)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("refuses to anonymise a staff account", async () => {
    await expect(anonymiseCustomer(superAdmin, staff.id)).rejects.toThrow(
      AnonymisationError,
    );
  });

  it("replaces the personal fields", async () => {
    await anonymiseCustomer(superAdmin, customer.id);

    const [row] = await harness.db
      .select({ email: users.email, phone: users.phone })
      .from(users)
      .where(eq(users.id, customer.id));

    expect(row.email).not.toContain("shopper@example.com");
    expect(row.phone).toBeNull();

    const [address] = await harness.db
      .select()
      .from(addresses)
      .where(eq(addresses.userId, customer.id));

    expect(address.recipientName).not.toBe("A Shopper");
    expect(address.addressLine1).not.toContain("Example Road");
  });

  /**
   * Financial records survive: deleting them would break tax obligations and
   * corrupt every revenue figure already reported.
   */
  it("keeps the orders that reference the account", async () => {
    const { variant } = await seedProduct();
    const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
    await addToCart(cartId, variant.id, 1);

    const placed = await placeOrder({
      cartId,
      userId: customer.id,
      guestEmail: customer.email,
      guestPhone: null,
      shippingAddressId: addressId,
      method: "card",
      idempotencyKey: "anon-1",
    });

    await anonymiseCustomer(superAdmin, customer.id);

    const [order] = await harness.db
      .select({ id: orders.id, totalBdt: orders.totalBdt })
      .from(orders)
      .where(eq(orders.id, placed.orderId));

    expect(order).toBeDefined();
    expect(order.totalBdt).toBe(500_00);
  });

  it("signs the account out and makes it unusable", async () => {
    const { token } = await createSession(customer.id);
    await anonymiseCustomer(superAdmin, customer.id);

    await expect(validateSessionToken(token)).resolves.toBeNull();

    const [row] = await harness.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, customer.id));

    // Not a valid argon2 hash, so no password can ever verify against it.
    expect(row.passwordHash).toBe("anonymised");
  });

  it("audits the anonymisation", async () => {
    await anonymiseCustomer(superAdmin, customer.id);

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user.deactivated"));

    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(superAdmin.id);
  });
});

describe("database-level protection", () => {
  /** The application checks first; the database is the backstop. */
  it("refuses to reserve beyond capacity even by direct write", async () => {
    const { variant } = await seedProduct();

    const error = await harness.db
      .update(productVariants)
      .set({ preorderReserved: 999 })
      .where(eq(productVariants.id, variant.id))
      .then(() => null)
      .catch((thrown) => thrown);

    expect(error).not.toBeNull();
    expect(String(error.cause ?? error)).toMatch(/check constraint/i);
  });

  it("refuses an unknown role even by direct write", async () => {
    const error = await harness.db
      .update(users)
      .set({ role: "root" })
      .where(eq(users.id, customer.id))
      .then(() => null)
      .catch((thrown) => thrown);

    expect(error).not.toBeNull();
    expect(String(error.cause ?? error)).toMatch(/users_role_check/);
  });

  it("keeps order numbers unique", async () => {
    const [row] = await harness.client.query<{ count: string }>(
      `select count(*)::text as count from information_schema.table_constraints
       where table_name = 'orders' and constraint_type = 'UNIQUE'`,
    ).then((result) => result.rows);

    expect(Number(row.count)).toBeGreaterThan(0);
  });
});

describe("parameterised queries", () => {
  /**
   * Drizzle parameterises everything, so a value that looks like SQL is
   * treated as data. Asserted rather than assumed.
   */
  it("treats an injection attempt as an ordinary string", async () => {
    const nasty = "'; drop table users; --";

    await createCategory(staff, { name: nasty, slug: "injection-attempt" });

    const [{ count }] = await harness.db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);

    // The users table is still there, with its three rows.
    expect(count).toBe(3);
  });
});
