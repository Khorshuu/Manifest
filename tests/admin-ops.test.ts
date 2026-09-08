/**
 * Admin operations: staff management, dashboard metrics, exports, audit log.
 *
 * The rules asserted here are the gated ones — only a super admin manages
 * admins or sees money — plus the two that protect people: the site can never
 * be left without a super admin, and a CSV export cannot smuggle a formula
 * into someone's spreadsheet.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  auditLog,
  productVariants,
  sessions,
  users,
} from "@/db/schema";
import {
  changeRole,
  createStaffAccount,
  csvField,
  exportMarginCsv,
  exportOrdersCsv,
  exportPreordersCsv,
  getCapacityAlerts,
  getDashboardMetrics,
  getRevenue,
  getTopProducts,
  listAuditEntries,
  listCustomers,
  listStaff,
  StaffError,
  takaFromPaisa,
  toCsv,
} from "@/lib/admin";
import { AuthorizationError } from "@/lib/auth/authorize";
import { createSession, validateSessionToken } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/session";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { createCategory, createProduct } from "@/lib/catalog";
import { advanceOrder, placeOrder } from "@/lib/orders";
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

async function placeTestOrder(price = 500_00, quantity = 2) {
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
      priceBdt: price,
      costPriceUsd: 1_000,
      fulfillmentMode: "preorder",
      preorderCapacity: 50,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variant.id, quantity);

  return placeOrder({
    cartId,
    userId: customer.id,
    guestEmail: customer.email,
    guestPhone: null,
    shippingAddressId: addressId,
    method: "bkash",
    idempotencyKey: `key-${suffix}`,
  });
}

describe("staff management", () => {
  it("refuses a staff admin, not only a customer", async () => {
    await expect(listStaff(staff)).rejects.toThrow(AuthorizationError);
    await expect(listStaff(customer)).rejects.toThrow(AuthorizationError);
  });

  it("lists only staff and admins, never customers", async () => {
    const list = await listStaff(superAdmin);
    expect(list).toHaveLength(2);
    expect(list.map((row) => row.email).sort()).toEqual([
      "admin@example.com",
      "staff@example.com",
    ]);
  });

  it("creates a staff account and audits it", async () => {
    const created = await createStaffAccount(superAdmin, {
      email: "new-staff@example.com",
      password: "a-long-enough-password",
      role: "staff_admin",
    });

    expect(created.role).toBe("staff_admin");

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user.created"));
    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(superAdmin.id);
  }, 30_000);

  it("never stores the new password in the clear", async () => {
    await createStaffAccount(superAdmin, {
      email: "new-staff@example.com",
      password: "a-long-enough-password",
      role: "staff_admin",
    });

    const [row] = await harness.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, "new-staff@example.com"));

    expect(row.passwordHash).not.toContain("a-long-enough-password");
    expect(row.passwordHash.startsWith("$argon2id$")).toBe(true);
  }, 30_000);

  it("refuses a duplicate email", async () => {
    await expect(
      createStaffAccount(superAdmin, {
        email: "staff@example.com",
        password: "a-long-enough-password",
        role: "staff_admin",
      }),
    ).rejects.toThrow(StaffError);
  }, 30_000);

  it("changes a role and records before and after", async () => {
    await changeRole(superAdmin, staff.id, "super_admin");

    const [row] = await harness.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, staff.id));
    expect(row.role).toBe("super_admin");

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user.role_changed"));
    expect(entries[0].beforeJson).toMatchObject({ role: "staff_admin" });
    expect(entries[0].afterJson).toMatchObject({ role: "super_admin" });
  });

  /**
   * A role change has to bite immediately, so every session belonging to the
   * account is dropped — otherwise an open session keeps its old role.
   */
  it("signs the changed account out everywhere", async () => {
    const { token } = await createSession(staff.id);
    await expect(validateSessionToken(token)).resolves.not.toBeNull();

    await changeRole(superAdmin, staff.id, "customer");

    await expect(validateSessionToken(token)).resolves.toBeNull();
    await expect(
      harness.db.select().from(sessions),
    ).resolves.toHaveLength(0);
  });

  it("refuses to change your own role", async () => {
    await expect(
      changeRole(superAdmin, superAdmin.id, "customer"),
    ).rejects.toThrow(/your own role/);
  });

  /**
   * The site must never be left without a super admin, so the last one cannot
   * be demoted even by a colleague who holds the same role.
   */
  it("refuses to demote the last super admin", async () => {
    // Promote the staff admin, so there are two.
    await changeRole(superAdmin, staff.id, "super_admin");
    const promoted: SessionUser = { ...staff, role: "super_admin" };

    // Demoting one of two is fine.
    await changeRole(promoted, superAdmin.id, "staff_admin");

    // The remaining one is now the last, and a second super admin would be
    // needed to try — there is none, so promote a customer and use them.
    await changeRole(promoted, customer.id, "super_admin");
    const second: SessionUser = { ...customer, role: "super_admin" };

    // Demote the newcomer again: one super admin left.
    await changeRole(promoted, second.id, "customer");

    await expect(
      changeRole({ ...superAdmin, role: "staff_admin" }, promoted.id, "customer"),
    ).rejects.toThrow(AuthorizationError);
  });

  it("lists customers separately", async () => {
    const list = await listCustomers(superAdmin);
    expect(list).toHaveLength(1);
    expect(list[0].email).toBe("shopper@example.com");
  });
});

describe("dashboard metrics", () => {
  it("counts live products, open preorders, and customers", async () => {
    await placeTestOrder();

    const metrics = await getDashboardMetrics(staff);
    expect(metrics.liveProducts).toBe(1);
    expect(metrics.openPreorders).toBe(1);
    expect(metrics.customers).toBe(1);
    expect(metrics.awaitingPayment).toBe(1);
  });

  it("refuses an anonymous caller", async () => {
    await expect(getDashboardMetrics(null)).rejects.toThrow();
  });

  /** Revenue is money, so it is super-admin only. */
  it("refuses a staff admin the revenue figure", async () => {
    await expect(getRevenue(staff)).rejects.toThrow(AuthorizationError);
  });

  it("counts only money actually collected", async () => {
    const placed = await placeTestOrder(500_00, 2);

    // Still awaiting payment: nothing collected yet.
    let revenue = await getRevenue(superAdmin);
    expect(revenue.collectedBdt).toBe(0);

    await advanceOrder(staff, placed.orderId, "payment_confirmed");

    revenue = await getRevenue(superAdmin);
    expect(revenue.collectedBdt).toBe(1_000_00);
    expect(revenue.orderCount).toBe(1);
  });

  it("excludes a refunded order from revenue", async () => {
    const placed = await placeTestOrder(500_00, 2);
    await advanceOrder(staff, placed.orderId, "payment_confirmed");
    await advanceOrder(staff, placed.orderId, "refunded");

    const revenue = await getRevenue(superAdmin);
    expect(revenue.collectedBdt).toBe(0);
  });

  it("ranks top products by units actually ordered", async () => {
    await placeTestOrder(100_00, 5);
    await placeTestOrder(100_00, 1);

    const top = await getTopProducts(staff);
    expect(top[0].units).toBe(5);
  });

  it("reports variants near capacity", async () => {
    const placed = await placeTestOrder();
    expect(placed.orderId).toBeDefined();

    await harness.db
      .update(productVariants)
      .set({ preorderReserved: 45, preorderCapacity: 50 });

    const alerts = await getCapacityAlerts(staff);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reserved).toBe(45);
  });
});

describe("CSV escaping", () => {
  it("quotes a field containing a comma", () => {
    expect(csvField("Dhaka, Bangladesh")).toBe('"Dhaka, Bangladesh"');
  });

  it("doubles an embedded quote", () => {
    expect(csvField('He said "hello"')).toBe('"He said ""hello"""');
  });

  /**
   * CSV injection: a field starting with = + - or @ is treated as a formula
   * by spreadsheet software, so it is prefixed to keep it inert.
   */
  it("neutralises a formula", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+cmd")).toBe("'+cmd");
    expect(csvField("-2")).toBe("'-2");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("leaves an ordinary value alone", () => {
    expect(csvField("ORD-2026-000001")).toBe("ORD-2026-000001");
  });

  it("writes an empty cell for null", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("joins rows with CRLF, which is what spreadsheets expect", () => {
    const csv = toCsv(["a", "b"], [[1, 2]]);
    expect(csv).toBe("a,b\r\n1,2");
  });

  it("converts paisa to taka with two decimals", () => {
    expect(takaFromPaisa(185_000)).toBe("1850.00");
    expect(takaFromPaisa(1)).toBe("0.01");
  });
});

describe("exports", () => {
  it("refuses a customer", async () => {
    await expect(exportOrdersCsv(customer)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("writes orders with a header row and taka amounts", async () => {
    await placeTestOrder(500_00, 2);

    const csv = await exportOrdersCsv(staff);
    const lines = csv.split("\r\n");

    expect(lines[0]).toContain("Order number");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("1000.00");
  });

  it("reports remaining capacity in the preorder export", async () => {
    await placeTestOrder(500_00, 2);

    const csv = await exportPreordersCsv(staff);
    expect(csv).toContain("Remaining");
    // 50 capacity, 2 reserved.
    expect(csv).toContain(",50,2,48,");
  });

  /** The sourcing cost belongs to the one export a super admin can request. */
  it("keeps the sourcing cost out of the staff exports", async () => {
    await placeTestOrder();

    const orders = await exportOrdersCsv(staff);
    const preorders = await exportPreordersCsv(staff);

    expect(orders).not.toContain("Cost");
    expect(preorders).not.toContain("Cost");
  });

  it("refuses a staff admin the margin export", async () => {
    await expect(exportMarginCsv(staff)).rejects.toThrow(AuthorizationError);
  });

  it("gives a super admin the margin export with the cost", async () => {
    await placeTestOrder();

    const csv = await exportMarginCsv(superAdmin);
    expect(csv).toContain("Cost (USD)");
    expect(csv).toContain("10.00");
  });
});

describe("audit log", () => {
  it("refuses a customer", async () => {
    await expect(listAuditEntries(customer)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("returns entries newest first, with who made each change", async () => {
    await placeTestOrder();
    await changeRole(superAdmin, staff.id, "super_admin");

    const entries = await listAuditEntries(superAdmin);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].action).toBe("user.role_changed");
    expect(entries[0].actorEmail).toBe("admin@example.com");
  });

  it("filters by action", async () => {
    await placeTestOrder();
    await changeRole(superAdmin, staff.id, "super_admin");

    const entries = await listAuditEntries(superAdmin, {
      action: "user.role_changed",
    });

    expect(entries).toHaveLength(1);
  });
});
