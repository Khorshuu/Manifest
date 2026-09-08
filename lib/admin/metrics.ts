import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  orderItems,
  orders,
  productVariants,
  products,
  users,
} from "@/db/schema";
import { requireStaff, requireSuperAdmin } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Dashboard figures.
 *
 * Every number here is a live query. Nothing is cached and presented as
 * current, and nothing is a plausible-looking placeholder — if a metric
 * cannot be computed it is reported as unavailable rather than invented
 * (CLAUDE.md section 7).
 */

/** Money collected: only orders that got past payment, minus refunds. */
export async function getRevenue(
  actor: SessionUser | null,
  since?: Date,
): Promise<{ collectedBdt: number; orderCount: number }> {
  // Financial reporting is super-admin only (docs/BUSINESS_LOGIC.md).
  requireSuperAdmin(actor);

  const filters = [
    sql`${orders.status} not in ('placed', 'cancelled', 'refunded')`,
  ];
  if (since) filters.push(gte(orders.placedAt, since));

  const [row] = await db
    .select({
      collectedBdt: sql<string>`coalesce(sum(${orders.amountDueNowBdt}), 0)::text`,
      orderCount: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(and(...filters));

  return {
    collectedBdt: Number(row.collectedBdt),
    orderCount: row.orderCount,
  };
}

export type DashboardMetrics = {
  liveProducts: number;
  openPreorders: number;
  awaitingPayment: number;
  inFlight: number;
  customers: number;
  nearCapacity: number;
};

export async function getDashboardMetrics(
  actor: SessionUser | null,
): Promise<DashboardMetrics> {
  requireStaff(actor);

  const [liveProducts] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(products)
    .where(sql`${products.archivedAt} is null`);

  const [openPreorders] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(productVariants)
    .where(
      sql`${productVariants.fulfillmentMode} = 'preorder'
          and ${productVariants.archivedAt} is null
          and ${productVariants.isEnabled} = true
          and (${productVariants.preorderClosesAt} is null
               or ${productVariants.preorderClosesAt} > now())`,
    );

  const [awaitingPayment] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.status, "placed"));

  const [inFlight] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      sql`${orders.status} in ('payment_confirmed', 'sourcing',
        'shipped_from_us', 'in_bd_customs', 'out_for_delivery')`,
    );

  const [customers] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, "customer"));

  const [nearCapacity] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(productVariants)
    .where(
      sql`${productVariants.preorderCapacity} is not null
          and ${productVariants.archivedAt} is null
          and ${productVariants.preorderReserved} >=
              ${productVariants.preorderCapacity} * 0.8`,
    );

  return {
    liveProducts: liveProducts.value,
    openPreorders: openPreorders.value,
    awaitingPayment: awaitingPayment.value,
    inFlight: inFlight.value,
    customers: customers.value,
    nearCapacity: nearCapacity.value,
  };
}

/** Best sellers by units actually ordered, excluding cancelled and refunded. */
export async function getTopProducts(
  actor: SessionUser | null,
  limit = 5,
): Promise<{ title: string; units: number; revenueBdt: number }[]> {
  requireStaff(actor);

  const rows = await db
    .select({
      title: orderItems.titleSnapshot,
      units: sql<number>`sum(${orderItems.quantity})::int`,
      revenueBdt: sql<string>`sum(${orderItems.unitPriceBdt} * ${orderItems.quantity})::text`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(sql`${orders.status} not in ('cancelled', 'refunded')`)
    .groupBy(orderItems.titleSnapshot)
    .orderBy(desc(sql`sum(${orderItems.quantity})`))
    .limit(limit);

  return rows.map((row) => ({
    title: row.title,
    units: row.units,
    revenueBdt: Number(row.revenueBdt),
  }));
}

/** Most recent orders, for the dashboard's activity list. */
export async function getRecentOrders(actor: SessionUser | null, limit = 5) {
  requireStaff(actor);

  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalBdt: orders.totalBdt,
      placedAt: orders.placedAt,
    })
    .from(orders)
    .orderBy(desc(orders.placedAt))
    .limit(limit);
}

/** Preorder variants at or above a share of capacity. */
export async function getCapacityAlerts(
  actor: SessionUser | null,
  threshold = 0.8,
) {
  requireStaff(actor);

  return db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      title: products.title,
      capacity: productVariants.preorderCapacity,
      reserved: productVariants.preorderReserved,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      sql`${productVariants.preorderCapacity} is not null
          and ${productVariants.archivedAt} is null
          and ${productVariants.preorderReserved} >=
              ${productVariants.preorderCapacity} * cast(${threshold} as numeric)`,
    )
    .orderBy(desc(productVariants.preorderReserved));
}
