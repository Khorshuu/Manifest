import type { Metadata } from "next";
import { count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, productVariants, products, users } from "@/db/schema";
import { getCurrentUser, isSuperAdmin } from "@/lib/auth";
import { formatBdt } from "@/lib/money";
import { StatusBadge } from "@/components/status-badge";

export const metadata: Metadata = {
  title: "Overview",
};

export const dynamic = "force-dynamic";

/**
 * Every figure here is a live query against real data — never a placeholder,
 * per MASTER_PRODUCT_SPEC.md section 4 and CLAUDE.md section 7.
 */
async function loadMetrics(includeFinancials: boolean) {
  const [productCount] = await db
    .select({ value: count() })
    .from(products)
    .where(sql`${products.archivedAt} is null`);

  const [openPreorders] = await db
    .select({ value: count() })
    .from(productVariants)
    .where(
      sql`${productVariants.fulfillmentMode} = 'preorder'
          and ${productVariants.archivedAt} is null
          and (${productVariants.preorderClosesAt} is null
               or ${productVariants.preorderClosesAt} > now())`,
    );

  const [lowCapacity] = await db
    .select({ value: count() })
    .from(productVariants)
    .where(
      sql`${productVariants.preorderCapacity} is not null
          and ${productVariants.preorderReserved} >= ${productVariants.preorderCapacity} * 0.8`,
    );

  const [pendingOrders] = await db
    .select({ value: count() })
    .from(orders)
    .where(eq(orders.status, "placed"));

  const [customerCount] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.role, "customer"));

  // Revenue is money actually collected, so only orders past payment.
  const revenue = includeFinancials
    ? await db
        .select({
          value: sql<string>`coalesce(sum(${orders.amountDueNowBdt}), 0)::text`,
        })
        .from(orders)
        .where(sql`${orders.status} not in ('placed', 'cancelled', 'refunded')`)
    : null;

  return {
    productCount: productCount.value,
    openPreorders: openPreorders.value,
    lowCapacity: lowCapacity.value,
    pendingOrders: pendingOrders.value,
    customerCount: customerCount.value,
    revenueBdt: revenue ? Number(revenue[0].value) : null,
  };
}

export default async function AdminOverviewPage() {
  const user = await getCurrentUser();
  // Financial totals are super_admin only — see docs/BUSINESS_LOGIC.md.
  const showFinancials = isSuperAdmin(user);
  const metrics = await loadMetrics(showFinancials);

  const tiles = [
    { label: "Live products", value: String(metrics.productCount) },
    { label: "Open preorders", value: String(metrics.openPreorders) },
    { label: "Awaiting payment", value: String(metrics.pendingOrders) },
    { label: "Customers", value: String(metrics.customerCount) },
    ...(showFinancials && metrics.revenueBdt !== null
      ? [{ label: "Collected to date", value: formatBdt(metrics.revenueBdt) }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="text-meta text-blue-400">Overview</p>
        <h1 className="mt-2 font-display text-h1 text-ink">Today</h1>
      </div>

      <dl className="grid grid-cols-1 gap-px border border-blue-300 bg-blue-300 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-paper p-4">
            <dt className="text-meta text-ink/70">{tile.label}</dt>
            <dd className="mt-2 font-display text-h2 text-ink tabular-nums">
              {tile.value}
            </dd>
          </div>
        ))}
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-h2 text-ink">Capacity</h2>
        <p className="text-body text-ink/80">
          {metrics.lowCapacity > 0 ? (
            <>
              <StatusBadge tone="negative">
                {metrics.lowCapacity} at or above 80% capacity
              </StatusBadge>{" "}
              Review these before the preorder window closes.
            </>
          ) : (
            <StatusBadge tone="positive">
              No variants near capacity
            </StatusBadge>
          )}
        </p>
      </section>

      <p className="text-meta text-ink/60">
        Product management, the order pipeline, and staff tools arrive in later
        phases. Every number above is queried live — nothing here is a
        placeholder.
      </p>
    </div>
  );
}
