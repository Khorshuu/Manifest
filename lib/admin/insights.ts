import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  notifications,
  orderItems,
  orders,
  productVariants,
  products,
  reviews,
  users,
} from "@/db/schema";
import { can, requireAnyPermission, requirePermission, requireStaff } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { SPENT_ORDER_STATUSES } from "./customers";
import type { DateRange } from "./analytics";

/**
 * The figures behind the admin overview and the analytics page.
 *
 * Every number is a live query against the tables the shop writes. "Sales"
 * means paid orders that were not cancelled or refunded — the same statuses
 * the customer list counts as spent — valued at the order total. Money is only
 * computed for a role holding `finance.view`; for anyone else it is `null`,
 * not zero, so a screen can tell "hidden" from "nothing sold".
 */

const paidStatuses = [...SPENT_ORDER_STATUSES];

const inRange = (range: DateRange) =>
  and(gte(orders.placedAt, range.from), lt(orders.placedAt, range.to));

/** The same length of time immediately before `range`, for comparisons. */
export function previousRange(range: DateRange): DateRange {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: range.from };
}

export type SalesSummary = {
  /** Order value of paid orders, or null without `finance.view`. */
  salesBdt: number | null;
  paidOrders: number;
  placedOrders: number;
  /** Average paid order value, or null without `finance.view` or with no orders. */
  averageOrderBdt: number | null;
  newCustomers: number;
};

async function salesFor(range: DateRange, withMoney: boolean): Promise<SalesSummary> {
  const [row] = await db
    .select({
      placed: sql<number>`count(*)::int`,
      paid: sql<number>`(count(*) filter (where ${inArray(orders.status, paidStatuses)}))::int`,
      sales: sql<string>`coalesce(sum(${orders.totalBdt}) filter (where ${inArray(orders.status, paidStatuses)}), 0)::text`,
    })
    .from(orders)
    .where(inRange(range));

  const [signups] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        eq(users.role, "customer"),
        gte(users.createdAt, range.from),
        lt(users.createdAt, range.to),
      ),
    );

  const sales = Number(row.sales);
  return {
    salesBdt: withMoney ? sales : null,
    paidOrders: row.paid,
    placedOrders: row.placed,
    averageOrderBdt: withMoney && row.paid > 0 ? Math.round(sales / row.paid) : null,
    newCustomers: signups.value,
  };
}

/** Sales, orders and signups for a period and the period before it. */
export async function getSalesSummary(
  actor: SessionUser | null,
  range: DateRange,
): Promise<{ current: SalesSummary; previous: SalesSummary }> {
  const user = requireAnyPermission(actor, ["analytics.view", "orders.view", "finance.view"]);
  const withMoney = can(user, "finance.view");

  const [current, previous] = await Promise.all([
    salesFor(range, withMoney),
    salesFor(previousRange(range), withMoney),
  ]);
  return { current, previous };
}

export type DailyPoint = {
  day: string;
  orders: number;
  paidOrders: number;
  salesBdt: number | null;
  signups: number;
};

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * One row per calendar day of the range, including the quiet ones — a chart
 * that skips empty days draws a busy week where there was a slow one.
 */
export async function getDailySeries(
  actor: SessionUser | null,
  range: DateRange,
): Promise<DailyPoint[]> {
  const user = requireAnyPermission(actor, ["analytics.view", "finance.view"]);
  const withMoney = can(user, "finance.view");

  const [orderRows, signupRows] = await Promise.all([
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${orders.placedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        orders: sql<number>`count(*)::int`,
        paid: sql<number>`(count(*) filter (where ${inArray(orders.status, paidStatuses)}))::int`,
        sales: sql<string>`coalesce(sum(${orders.totalBdt}) filter (where ${inArray(orders.status, paidStatuses)}), 0)::text`,
      })
      .from(orders)
      .where(inRange(range))
      .groupBy(sql`1`),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${users.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(users)
      .where(
        and(
          eq(users.role, "customer"),
          gte(users.createdAt, range.from),
          lt(users.createdAt, range.to),
        ),
      )
      .groupBy(sql`1`),
  ]);

  const byDay = new Map(orderRows.map((row) => [row.day, row]));
  const signups = new Map(signupRows.map((row) => [row.day, row.count]));

  const points: DailyPoint[] = [];
  const cursor = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()));
  const end = range.to.getTime();
  // Capped so a mistyped custom range cannot build an enormous series.
  while (cursor.getTime() < end && points.length < 400) {
    const key = dayKey(cursor);
    const row = byDay.get(key);
    points.push({
      day: key,
      orders: row?.orders ?? 0,
      paidOrders: row?.paid ?? 0,
      salesBdt: withMoney ? Number(row?.sales ?? 0) : null,
      signups: signups.get(key) ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

export type TopProduct = {
  productId: string | null;
  title: string;
  units: number;
  orders: number;
  revenueBdt: number | null;
};

/** Best sellers by units on paid orders in the period. */
export async function getTopProductsInRange(
  actor: SessionUser | null,
  range: DateRange,
  limit = 5,
): Promise<TopProduct[]> {
  const user = requireStaff(actor);
  const withMoney = can(user, "finance.view");

  const rows = await db
    .select({
      productId: productVariants.productId,
      title: sql<string>`coalesce(max(${products.title}), max(${orderItems.titleSnapshot}))`,
      units: sql<number>`sum(${orderItems.quantity})::int`,
      orders: sql<number>`count(distinct ${orderItems.orderId})::int`,
      revenue: sql<string>`sum(${orderItems.unitPriceBdt} * ${orderItems.quantity})::text`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .where(and(inRange(range), inArray(orders.status, paidStatuses)))
    .groupBy(productVariants.productId)
    .orderBy(desc(sql`sum(${orderItems.quantity})`))
    .limit(limit);

  return rows.map((row) => ({
    productId: row.productId,
    title: row.title,
    units: row.units,
    orders: row.orders,
    revenueBdt: withMoney ? Number(row.revenue) : null,
  }));
}

export type CategoryPerformance = {
  categoryId: string | null;
  name: string;
  units: number;
  revenueBdt: number | null;
};

/**
 * Units (and, for finance, sales) by the top-level shelf each product sits
 * under. Rolled up to the root so "Snacks" is one row rather than five.
 */
export async function getCategoryPerformance(
  actor: SessionUser | null,
  range: DateRange,
): Promise<CategoryPerformance[]> {
  const user = requirePermission(actor, "analytics.view");
  const withMoney = can(user, "finance.view");

  const result = await db.execute<{
    category_id: string | null;
    name: string | null;
    units: number;
    revenue: string;
  }>(sql`
    with recursive roots as (
      select id, id as root_id from ${categories} where parent_id is null
      union all
      select c.id, r.root_id from ${categories} c join roots r on c.parent_id = r.id
    )
    select rc.id as category_id, rc.name as name,
      sum(oi.quantity)::int as units,
      sum(oi.unit_price_bdt * oi.quantity)::text as revenue
    from ${orderItems} oi
    join ${orders} o on o.id = oi.order_id
    left join ${productVariants} v on v.id = oi.variant_id
    left join ${products} p on p.id = v.product_id
    left join roots r on r.id = p.category_id
    left join ${categories} rc on rc.id = r.root_id
    where o.placed_at >= ${range.from.toISOString()}::timestamptz
      and o.placed_at < ${range.to.toISOString()}::timestamptz
      and o.status in (${sql.join(paidStatuses.map((status) => sql`${status}`), sql`, `)})
    group by rc.id, rc.name
    order by units desc
  `);

  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    category_id: string | null;
    name: string | null;
    units: number;
    revenue: string;
  }[];

  return rows.map((row) => ({
    categoryId: row.category_id,
    name: row.name ?? "Uncategorised",
    units: Number(row.units),
    revenueBdt: withMoney ? Number(row.revenue) : null,
  }));
}

export type CustomerInsights = {
  totalCustomers: number;
  /** Customers with at least one paid order, ever. */
  buyers: number;
  /** Customers with two or more paid orders, ever. */
  repeatBuyers: number;
  /** Paid orders placed by an account rather than as a guest, in the period. */
  accountOrderShare: number | null;
};

export async function getCustomerInsights(
  actor: SessionUser | null,
  range: DateRange,
): Promise<CustomerInsights> {
  requireAnyPermission(actor, ["analytics.view", "customers.view"]);

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(users)
    .where(eq(users.role, "customer"));

  const perCustomer = db
    .select({
      userId: orders.userId,
      paid: sql<number>`count(*)::int`.as("paid"),
    })
    .from(orders)
    .where(and(isNotNull(orders.userId), inArray(orders.status, paidStatuses)))
    .groupBy(orders.userId)
    .as("per_customer");

  const [buyers] = await db
    .select({
      buyers: sql<number>`count(*)::int`,
      repeat: sql<number>`(count(*) filter (where ${perCustomer.paid} >= 2))::int`,
    })
    .from(perCustomer);

  const [share] = await db
    .select({
      all: sql<number>`count(*)::int`,
      account: sql<number>`(count(*) filter (where ${orders.userId} is not null))::int`,
    })
    .from(orders)
    .where(and(inRange(range), inArray(orders.status, paidStatuses)));

  return {
    totalCustomers: counts.total,
    buyers: buyers?.buyers ?? 0,
    repeatBuyers: buyers?.repeat ?? 0,
    accountOrderShare: share.all === 0 ? null : share.account / share.all,
  };
}

/** The newest customer accounts, for the overview. */
export async function getRecentCustomers(actor: SessionUser | null, limit = 5) {
  requirePermission(actor, "customers.view");

  return db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.role, "customer"))
    .orderBy(desc(users.createdAt))
    .limit(limit);
}

export type StockAlert = {
  variantId: string;
  productId: string;
  title: string;
  sku: string;
  /** "low_stock" | "out_of_stock" for goods held; "preorder_full" | "preorder_near" for batches. */
  kind: "low_stock" | "out_of_stock" | "preorder_full" | "preorder_near";
  remaining: number;
  of: number | null;
};

/**
 * What is running out: held stock at or under its low-stock line (or empty),
 * and preorder batches at 80% or more of capacity. Only enabled, live
 * variants — an archived colourway running out is not news.
 */
export async function getStockAlerts(
  actor: SessionUser | null,
  limit = 8,
): Promise<StockAlert[]> {
  requireAnyPermission(actor, ["catalog.manage", "orders.view", "analytics.view"]);

  const rows = await db
    .select({
      variantId: productVariants.id,
      productId: productVariants.productId,
      title: products.title,
      sku: productVariants.sku,
      mode: productVariants.fulfillmentMode,
      stock: productVariants.stockQuantity,
      threshold: productVariants.lowStockThreshold,
      capacity: productVariants.preorderCapacity,
      reserved: productVariants.preorderReserved,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      sql`${productVariants.archivedAt} is null
        and ${productVariants.isEnabled} = true
        and ${products.archivedAt} is null
        and (
          (${productVariants.fulfillmentMode} = 'in_stock'
            and ${productVariants.stockQuantity} is not null
            and ${productVariants.stockQuantity} <= coalesce(${productVariants.lowStockThreshold}, 0))
          or
          (${productVariants.fulfillmentMode} = 'preorder'
            and ${productVariants.preorderCapacity} is not null
            and ${productVariants.preorderCapacity} > 0
            and ${productVariants.preorderReserved} >= ${productVariants.preorderCapacity} * 0.8)
        )`,
    )
    .orderBy(
      sql`case when ${productVariants.fulfillmentMode} = 'in_stock'
        then ${productVariants.stockQuantity}
        else ${productVariants.preorderCapacity} - ${productVariants.preorderReserved} end`,
    )
    .limit(limit);

  return rows.map((row) => {
    if (row.mode === "in_stock") {
      const stock = row.stock ?? 0;
      return {
        variantId: row.variantId,
        productId: row.productId,
        title: row.title,
        sku: row.sku,
        kind: stock <= 0 ? "out_of_stock" : "low_stock",
        remaining: stock,
        of: row.threshold,
      } satisfies StockAlert;
    }
    const remaining = (row.capacity ?? 0) - row.reserved;
    return {
      variantId: row.variantId,
      productId: row.productId,
      title: row.title,
      sku: row.sku,
      kind: remaining <= 0 ? "preorder_full" : "preorder_near",
      remaining: Math.max(0, remaining),
      of: row.capacity,
    } satisfies StockAlert;
  });
}

export type WorkQueue = {
  awaitingPayment: number;
  toSource: number;
  inTransit: number;
  cancellationRequests: number;
  pendingReviews: number;
  failedMessages: number;
};

/**
 * What is waiting on a person. Each count is computed only for a role that
 * could act on it; the rest are zero rather than revealed.
 */
export async function getWorkQueue(actor: SessionUser | null): Promise<WorkQueue> {
  const user = requireStaff(actor);
  const seesOrders = can(user, "orders.view");

  const [orderCounts] = seesOrders
    ? await db
        .select({
          awaiting: sql<number>`(count(*) filter (where ${orders.status} = 'placed'))::int`,
          toSource: sql<number>`(count(*) filter (where ${orders.status} = 'payment_confirmed'))::int`,
          transit: sql<number>`(count(*) filter (where ${orders.status} in ('sourcing', 'shipped_from_us', 'in_bd_customs', 'out_for_delivery')))::int`,
          cancellations: sql<number>`(count(*) filter (where ${orders.cancellationRequestedAt} is not null and ${orders.status} not in ('cancelled', 'refunded')))::int`,
        })
        .from(orders)
    : [{ awaiting: 0, toSource: 0, transit: 0, cancellations: 0 }];

  const [reviewCount] = can(user, "reviews.moderate")
    ? await db
        .select({ value: sql<number>`count(*)::int` })
        .from(reviews)
        .where(eq(reviews.status, "pending"))
    : [{ value: 0 }];

  const [failed] = can(user, "notifications.view")
    ? await db
        .select({ value: sql<number>`count(*)::int` })
        .from(notifications)
        .where(eq(notifications.status, "failed"))
    : [{ value: 0 }];

  return {
    awaitingPayment: orderCounts.awaiting,
    toSource: orderCounts.toSource,
    inTransit: orderCounts.transit,
    cancellationRequests: orderCounts.cancellations,
    pendingReviews: reviewCount.value,
    failedMessages: failed.value,
  };
}

/** Counts for the product list's header: live, drafts, archived. */
export async function getCatalogCounts(actor: SessionUser | null) {
  requireStaff(actor);

  const [row] = await db
    .select({
      live: sql<number>`(count(*) filter (where ${products.archivedAt} is null and ${products.status} not in ('draft', 'archived')))::int`,
      drafts: sql<number>`(count(*) filter (where ${products.archivedAt} is null and ${products.status} = 'draft'))::int`,
      archived: sql<number>`(count(*) filter (where ${products.archivedAt} is not null or ${products.status} = 'archived'))::int`,
    })
    .from(products);

  return row;
}

/**
 * Products filed directly in each category, drafts and archived included, for
 * the admin category tree. The storefront's counts show public listings only;
 * staff need to see what a category holds before they move or delete it.
 */
export async function countProductsByCategoryForAdmin(
  actor: SessionUser | null,
): Promise<Map<string, { total: number; live: number }>> {
  requirePermission(actor, "catalog.manage");

  const rows = await db
    .select({
      categoryId: products.categoryId,
      total: sql<number>`count(*)::int`,
      live: sql<number>`(count(*) filter (where ${products.archivedAt} is null and ${products.status} not in ('draft', 'archived')))::int`,
    })
    .from(products)
    .groupBy(products.categoryId);

  return new Map(
    rows
      .filter((row) => row.categoryId !== null)
      .map((row) => [row.categoryId as string, { total: row.total, live: row.live }]),
  );
}
