import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, users } from "@/db/schema";
import { requirePermission, type SessionUser } from "@/lib/auth";

/**
 * The statuses that count as money a customer has spent: paid, and not since
 * cancelled or refunded. An order still `placed` is awaiting payment and has
 * cost the shopper nothing yet; counting it made "spent" jump the moment
 * someone opened checkout and fall again when the unpaid order expired.
 *
 * The same rule `getRevenue` uses for the shop's own revenue, so the customer
 * list and the dashboard cannot disagree about which orders count.
 */
export const SPENT_ORDER_STATUSES = [
  "payment_confirmed",
  "sourcing",
  "shipped_from_us",
  "in_bd_customs",
  "out_for_delivery",
  "delivered",
] as const;

const spentStatusList = sql.raw(
  `(${SPENT_ORDER_STATUSES.map((status) => `'${status}'`).join(", ")})`,
);

/**
 * Customer accounts with what they have ordered, for /admin/customers.
 *
 * The totals are one grouped read of `orders` joined to the account, not a
 * correlated subquery per row. The subquery this replaced rendered the
 * account's id as a bare `"id"` — which, inside `from orders`, is the order's
 * own id — so every customer read as having no orders and nothing spent.
 */
export async function listCustomersWithOrders(
  actor: SessionUser | null,
  options: { query?: string; limit?: number; offset?: number } = {},
) {
  requirePermission(actor, "customers.view");

  const query = options.query?.trim();
  const pattern = query ? `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const where = and(
    eq(users.role, "customer"),
    pattern
      ? or(
          ilike(users.email, pattern),
          ilike(users.phone, pattern),
          ilike(users.firstName, pattern),
          ilike(users.lastName, pattern),
        )
      : undefined,
  );

  const totals = db
    .select({
      userId: orders.userId,
      orderCount: sql<number>`count(*)::int`.as("order_count"),
      paidCount:
        sql<number>`(count(*) filter (where ${orders.status} in ${spentStatusList}))::int`.as(
          "paid_count",
        ),
      spentBdt:
        sql<string>`coalesce(sum(${orders.totalBdt}) filter (where ${orders.status} in ${spentStatusList}), 0)::text`.as(
          "spent_bdt",
        ),
      lastOrderAt: sql<Date | null>`max(${orders.placedAt})`.as("last_order_at"),
    })
    .from(orders)
    .groupBy(orders.userId)
    .as("totals");

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        phone: users.phone,
        createdAt: users.createdAt,
        orderCount: totals.orderCount,
        paidCount: totals.paidCount,
        spentBdt: totals.spentBdt,
        lastOrderAt: totals.lastOrderAt,
      })
      .from(users)
      .leftJoin(totals, eq(totals.userId, users.id))
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0),
    db.select({ value: sql<number>`count(*)::int` }).from(users).where(where),
  ]);

  return {
    customers: rows.map((row) => ({
      ...row,
      orderCount: Number(row.orderCount ?? 0),
      paidCount: Number(row.paidCount ?? 0),
      spentBdt: Number(row.spentBdt ?? 0),
      lastOrderAt: row.lastOrderAt ? new Date(row.lastOrderAt) : null,
    })),
    total: Number(total?.value ?? 0),
  };
}
