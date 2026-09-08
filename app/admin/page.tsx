import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import {
  getCapacityAlerts,
  getDashboardMetrics,
  getRecentOrders,
  getRevenue,
  getTopProducts,
} from "@/lib/admin";
import { getCurrentUser, isSuperAdmin } from "@/lib/auth";
import { formatBdt } from "@/lib/money";
import { formatShortDate } from "@/lib/format";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

/**
 * Every figure here is a live query against real data. Nothing is a
 * placeholder, and a number a staff admin may not see is not computed at all
 * rather than computed and hidden (CLAUDE.md section 7).
 */
export default async function AdminOverviewPage() {
  const user = await getCurrentUser();
  const showFinancials = isSuperAdmin(user);

  const [metrics, recent, topProducts, alerts, revenue] = await Promise.all([
    getDashboardMetrics(user),
    getRecentOrders(user, 5),
    getTopProducts(user, 5),
    getCapacityAlerts(user),
    showFinancials ? getRevenue(user) : Promise.resolve(null),
  ]);

  const tiles = [
    { label: "Live products", value: String(metrics.liveProducts) },
    { label: "Open preorders", value: String(metrics.openPreorders) },
    { label: "Awaiting payment", value: String(metrics.awaitingPayment) },
    { label: "In flight", value: String(metrics.inFlight) },
    { label: "Customers", value: String(metrics.customers) },
    ...(revenue
      ? [{ label: "Collected to date", value: formatBdt(revenue.collectedBdt) }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-10">
      <div>
        <p className="text-meta text-blue-400">Overview</p>
        <h1 className="mt-2 font-display text-h1 text-ink">Today</h1>
      </div>

      <dl className="grid grid-cols-1 gap-px border border-blue-300 bg-blue-300 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-paper p-4">
            <dt className="text-meta text-ink/70">{tile.label}</dt>
            <dd className="mt-2 font-display text-h2 tabular-nums text-ink">
              {tile.value}
            </dd>
          </div>
        ))}
      </dl>

      <section>
        <h2 className="font-display text-h2 text-ink">Capacity alerts</h2>
        {alerts.length === 0 ? (
          <p className="mt-4">
            <StatusBadge tone="positive">Nothing near capacity</StatusBadge>
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto border border-blue-300">
            <table className="w-full min-w-[560px] border-collapse text-body">
              <thead>
                <tr className="text-left">
                  <th scope="col" className="px-4 py-3 text-meta font-medium">
                    Product
                  </th>
                  <th scope="col" className="px-4 py-3 text-meta font-medium">
                    SKU
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-meta font-medium"
                  >
                    Reserved
                  </th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert, index) => (
                  <tr
                    key={alert.variantId}
                    className={index % 2 === 1 ? "bg-blue-200/40" : undefined}
                  >
                    <td className="border-t border-blue-300 px-4 py-3">
                      {alert.title}
                    </td>
                    <td className="border-t border-blue-300 px-4 py-3 font-mono text-meta text-ink/70">
                      {alert.sku}
                    </td>
                    <td className="border-t border-blue-300 px-4 py-3 text-right tabular-nums">
                      {alert.reserved} / {alert.capacity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-display text-h2 text-ink">Recent orders</h2>
            <Link
              href="/admin/orders"
              className="text-meta text-blue-600 hover:underline"
            >
              All orders
            </Link>
          </div>

          {recent.length === 0 ? (
            <p className="mt-4 text-body text-ink/70">No orders yet.</p>
          ) : (
            <ul className="mt-4 border-t border-blue-300">
              {recent.map((order) => (
                <li
                  key={order.id}
                  className="flex items-center justify-between gap-4 border-b border-blue-300 py-3"
                >
                  <div>
                    <Link
                      href={`/admin/orders/${order.id}`}
                      className="tabular-nums text-blue-600 hover:underline"
                    >
                      {order.orderNumber}
                    </Link>
                    <p className="text-meta text-ink/60">
                      {formatShortDate(order.placedAt)} ·{" "}
                      {order.status.replace(/_/g, " ")}
                    </p>
                  </div>
                  <span className="tabular-nums text-ink">
                    {formatBdt(order.totalBdt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="font-display text-h2 text-ink">Top products</h2>
          {topProducts.length === 0 ? (
            <p className="mt-4 text-body text-ink/70">
              Nothing has been ordered yet.
            </p>
          ) : (
            <ul className="mt-4 border-t border-blue-300">
              {topProducts.map((product) => (
                <li
                  key={product.title}
                  className="flex items-center justify-between gap-4 border-b border-blue-300 py-3"
                >
                  <span className="text-body text-ink">{product.title}</span>
                  <span className="text-meta tabular-nums text-ink/70">
                    {product.units} unit{product.units === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section>
        <h2 className="font-display text-h2 text-ink">Reports</h2>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          Downloads a spreadsheet of the live data.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href="/api/admin/export?report=orders"
            className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
          >
            Orders (CSV)
          </a>
          <a
            href="/api/admin/export?report=preorders"
            className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
          >
            Preorder capacity (CSV)
          </a>
          {showFinancials ? (
            <a
              href="/api/admin/export?report=margin"
              className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
            >
              Margin (CSV)
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}
