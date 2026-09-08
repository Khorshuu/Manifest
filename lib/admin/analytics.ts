import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { carts, orders, productVariants, users } from "@/db/schema";
import { requireStaff, requireSuperAdmin } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Reporting.
 *
 * Everything here is computed from the tables the application already writes.
 * Where a figure cannot honestly be produced from what is recorded, the
 * function says so rather than approximating — see `getFunnel` below.
 */

export type DateRange = { from: Date; to: Date };

/** The last N whole days, ending now. */
export function lastDays(days: number, now: Date = new Date()): DateRange {
  const to = now;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

export type FunnelStep = {
  label: string;
  value: number;
  /** Share of the step above, or null for the first step. */
  conversionFromPrevious: number | null;
};

export type Funnel = {
  steps: FunnelStep[];
  /**
   * Steps the application does not record, named explicitly so a reader knows
   * what the funnel is missing rather than assuming it is complete.
   */
  missing: string[];
};

/**
 * The purchase funnel, from what is actually recorded.
 *
 * Product views are deliberately absent: nothing writes them today, and an
 * invented number would be worse than an honest gap (CLAUDE.md section 7).
 */
export async function getFunnel(
  actor: SessionUser | null,
  range: DateRange,
): Promise<Funnel> {
  requireStaff(actor);

  const [cartsStarted] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(carts)
    .where(and(gte(carts.createdAt, range.from), lt(carts.createdAt, range.to)));

  const [ordersPlaced] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(gte(orders.placedAt, range.from), lt(orders.placedAt, range.to)),
    );

  const [ordersPaid] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        gte(orders.placedAt, range.from),
        lt(orders.placedAt, range.to),
        sql`${orders.status} not in ('placed', 'cancelled', 'refunded')`,
      ),
    );

  const [ordersDelivered] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        gte(orders.placedAt, range.from),
        lt(orders.placedAt, range.to),
        sql`${orders.status} = 'delivered'`,
      ),
    );

  const raw = [
    { label: "Carts started", value: cartsStarted.value },
    { label: "Orders placed", value: ordersPlaced.value },
    { label: "Payment confirmed", value: ordersPaid.value },
    { label: "Delivered", value: ordersDelivered.value },
  ];

  const steps: FunnelStep[] = raw.map((step, index) => {
    if (index === 0) return { ...step, conversionFromPrevious: null };

    const previous = raw[index - 1].value;
    return {
      ...step,
      conversionFromPrevious: previous === 0 ? 0 : step.value / previous,
    };
  });

  return {
    steps,
    missing: [
      "Product views — nothing records them yet, so the top of the funnel is missing.",
      "Add-to-cart events — only the resulting cart is recorded, not each attempt.",
    ],
  };
}

export type RevenuePoint = {
  day: string;
  collectedBdt: number;
  orderCount: number;
};

/** Money collected per day, for the revenue chart. Super admin only. */
export async function getRevenueByDay(
  actor: SessionUser | null,
  range: DateRange,
): Promise<RevenuePoint[]> {
  requireSuperAdmin(actor);

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${orders.placedAt}), 'YYYY-MM-DD')`,
      collectedBdt: sql<string>`coalesce(sum(${orders.amountDueNowBdt}), 0)::text`,
      orderCount: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(
      and(
        gte(orders.placedAt, range.from),
        lt(orders.placedAt, range.to),
        sql`${orders.status} not in ('placed', 'cancelled', 'refunded')`,
      ),
    )
    .groupBy(sql`date_trunc('day', ${orders.placedAt})`)
    .orderBy(sql`date_trunc('day', ${orders.placedAt})`);

  return rows.map((row) => ({
    day: row.day,
    collectedBdt: Number(row.collectedBdt),
    orderCount: row.orderCount,
  }));
}

export type PreorderCommitment = {
  totalCapacity: number;
  totalReserved: number;
  /** Reserved as a share of capacity, across every capped preorder variant. */
  utilisation: number;
  fullVariants: number;
};

/** How much of the offered preorder capacity has actually been taken. */
export async function getPreorderCommitment(
  actor: SessionUser | null,
): Promise<PreorderCommitment> {
  requireStaff(actor);

  const [row] = await db
    .select({
      totalCapacity: sql<string>`coalesce(sum(${productVariants.preorderCapacity}), 0)::text`,
      totalReserved: sql<string>`coalesce(sum(${productVariants.preorderReserved}), 0)::text`,
      fullVariants: sql<number>`count(*) filter (
        where ${productVariants.preorderReserved} >= ${productVariants.preorderCapacity}
      )::int`,
    })
    .from(productVariants)
    .where(
      sql`${productVariants.preorderCapacity} is not null
          and ${productVariants.archivedAt} is null`,
    );

  const totalCapacity = Number(row.totalCapacity);
  const totalReserved = Number(row.totalReserved);

  return {
    totalCapacity,
    totalReserved,
    utilisation: totalCapacity === 0 ? 0 : totalReserved / totalCapacity,
    fullVariants: row.fullVariants,
  };
}

/** New customer registrations per day. */
export async function getSignupsByDay(
  actor: SessionUser | null,
  range: DateRange,
): Promise<{ day: string; count: number }[]> {
  requireStaff(actor);

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${users.createdAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(users)
    .where(
      and(
        gte(users.createdAt, range.from),
        lt(users.createdAt, range.to),
        sql`${users.role} = 'customer'`,
      ),
    )
    .groupBy(sql`date_trunc('day', ${users.createdAt})`)
    .orderBy(sql`date_trunc('day', ${users.createdAt})`);

  return rows.map((row) => ({ day: row.day, count: row.count }));
}

export type OrderStatusBreakdown = { status: string; count: number };

/** How many orders sit at each stage right now. */
export async function getStatusBreakdown(
  actor: SessionUser | null,
): Promise<OrderStatusBreakdown[]> {
  requireStaff(actor);

  const rows = await db
    .select({
      status: orders.status,
      count: sql<number>`count(*)::int`,
    })
    .from(orders)
    .groupBy(orders.status);

  return rows.map((row) => ({ status: row.status, count: row.count }));
}
