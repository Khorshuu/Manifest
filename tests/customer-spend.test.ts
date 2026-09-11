/**
 * What Admin → Customers says each customer has spent.
 *
 * The regression this guards: the list used a correlated subquery whose
 * account id Drizzle rendered as a bare "id", which inside `from orders` is the
 * order's own id — so every customer read as no orders and nothing spent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addresses, orders, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { listCustomersWithOrders } from "@/lib/admin";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const owner: SessionUser = { id: "", email: "owner@example.com", role: "super_admin" };
const support: SessionUser = { id: "", email: "support@example.com", role: "support" };
const catalogue: SessionUser = { id: "", email: "catalogue@example.com", role: "product_manager" };

let shopperId = "";
let otherId = "";
let addressId = "";
let sequence = 0;

async function order(userId: string | null, totalBdt: number, status: string) {
  sequence += 1;
  await harness.db.insert(orders).values({
    orderNumber: `T-${sequence}`,
    userId,
    guestEmail: userId ? null : "guest@example.com",
    status,
    subtotalBdt: totalBdt,
    totalBdt,
    amountDueNowBdt: totalBdt,
    idempotencyKey: `key-${sequence}`,
    shippingAddressId: addressId,
  });
}

async function spentOf(email: string) {
  const { customers } = await listCustomersWithOrders(owner, { query: email });
  return customers.find((customer) => customer.email === email)!;
}

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
      { email: owner.email, passwordHash: "x", role: "super_admin" },
      { email: support.email, passwordHash: "x", role: "support" },
      { email: catalogue.email, passwordHash: "x", role: "product_manager" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer", firstName: "Nadia" },
      { email: "other@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  const idOf = (email: string) => rows.find((row) => row.email === email)!.id;
  owner.id = idOf(owner.email);
  support.id = idOf(support.email);
  catalogue.id = idOf(catalogue.email);
  shopperId = idOf("shopper@example.com");
  otherId = idOf("other@example.com");

  const [address] = await harness.db
    .insert(addresses)
    .values({
      recipientName: "Test",
      phone: "01700000000",
      addressLine1: "1 Road",
      city: "Dhaka",
      district: "Dhaka",
    })
    .returning({ id: addresses.id });
  addressId = address.id;
});

describe("total spent", () => {
  it("is zero for a customer with no orders", async () => {
    const shopper = await spentOf("shopper@example.com");
    expect(shopper.spentBdt).toBe(0);
    expect(shopper.orderCount).toBe(0);
    expect(shopper.lastOrderAt).toBeNull();
  });

  it("counts a paid order", async () => {
    await order(shopperId, 250_000, "payment_confirmed");
    const shopper = await spentOf("shopper@example.com");
    expect(shopper.spentBdt).toBe(250_000);
    expect(shopper.paidCount).toBe(1);
    expect(shopper.lastOrderAt).not.toBeNull();
  });

  it("accumulates across orders at every paid stage", async () => {
    await order(shopperId, 100_000, "payment_confirmed");
    await order(shopperId, 200_000, "shipped_from_us");
    await order(shopperId, 300_000, "delivered");
    expect((await spentOf("shopper@example.com")).spentBdt).toBe(600_000);
  });

  it("leaves out unpaid, cancelled and refunded orders but still counts them as orders", async () => {
    await order(shopperId, 100_000, "delivered");
    await order(shopperId, 999_000, "placed");
    await order(shopperId, 555_000, "cancelled");
    await order(shopperId, 444_000, "refunded");
    const shopper = await spentOf("shopper@example.com");
    expect(shopper.spentBdt).toBe(100_000);
    expect(shopper.paidCount).toBe(1);
    expect(shopper.orderCount).toBe(4);
  });

  it("never gives one customer another's orders, or a guest's", async () => {
    await order(shopperId, 100_000, "delivered");
    await order(otherId, 700_000, "delivered");
    await order(null, 900_000, "delivered");
    expect((await spentOf("shopper@example.com")).spentBdt).toBe(100_000);
    expect((await spentOf("other@example.com")).spentBdt).toBe(700_000);
  });

  it("finds a customer by first name", async () => {
    const { customers } = await listCustomersWithOrders(owner, { query: "nadia" });
    expect(customers.map((customer) => customer.email)).toEqual(["shopper@example.com"]);
  });
});

describe("who may see it", () => {
  it("allows roles that hold customers.view", async () => {
    await expect(listCustomersWithOrders(support)).resolves.toBeTruthy();
  });

  it("refuses a role without it", async () => {
    await expect(listCustomersWithOrders(catalogue)).rejects.toThrow();
  });
});
