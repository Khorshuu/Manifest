import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import {
  getCatalogCounts,
  getDailySeries,
  getRecentCustomers,
  getSalesSummary,
  getStockAlerts,
  getTopProductsInRange,
  getWorkQueue,
  lastDays,
} from "@/lib/admin";
import { searchOrdersForStaff } from "@/lib/orders";
import { can, isStaffRole, ROLE_DETAILS } from "@/lib/auth";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { formatBdt } from "@/lib/money";
import { formatShortDate } from "@/lib/format";
import { BarChart, Delta, ShareBar, shortDay } from "./charts";
import { ORDER_STATUS_LABELS, orderStatusTone } from "./order-status";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

/**
 * The business at a glance.
 *
 * Every figure is a live query; nothing is a placeholder. What a role cannot
 * see is not computed and not shown — money needs `finance.view`, orders need
 * `orders.view` — so the page adapts to the person reading it rather than
 * printing zeros where a number is withheld.
 */
export default async function AdminOverviewPage({
  searchParams,
}: PageProps<"/admin">) {
  const user = await requireAdminPage();
  const params = await searchParams;
  const days = params.days === "7" ? 7 : params.days === "90" ? 90 : 30;
  const range = lastDays(days);

  const money = can(user, "finance.view");
  const seesOrders = can(user, "orders.view");
  const seesTrends = can(user, "analytics.view") || money;
  const seesSummary = seesTrends || seesOrders;
  const seesCustomers = can(user, "customers.view");
  const seesStock =
    can(user, "catalog.manage") || seesOrders || can(user, "analytics.view");

  const [summary, series, queue, recent, top, stock, customers, catalog] =
    await Promise.all([
      seesSummary ? getSalesSummary(user, range) : null,
      seesTrends ? getDailySeries(user, range) : null,
      getWorkQueue(user),
      seesOrders ? searchOrdersForStaff(user, { limit: 6 }) : null,
      getTopProductsInRange(user, range, 5),
      seesStock ? getStockAlerts(user, 6) : null,
      seesCustomers ? getRecentCustomers(user, 5) : null,
      getCatalogCounts(user),
    ]);

  const roleLabel = isStaffRole(user.role) ? ROLE_DETAILS[user.role].label : "Staff";
  const greeting = user.firstName ? `Hello, ${user.firstName}` : "Overview";

  const attention = [
    { show: seesOrders, count: queue.cancellationRequests, label: "Cancellation requests", href: "/admin/orders?status=cancellation_requested" },
    { show: seesOrders, count: queue.awaitingPayment, label: "Orders awaiting payment", href: "/admin/orders?status=placed" },
    { show: seesOrders, count: queue.toSource, label: "Paid orders to source", href: "/admin/orders?status=payment_confirmed" },
    { show: can(user, "reviews.moderate"), count: queue.pendingReviews, label: "Reviews to moderate", href: "/admin/reviews" },
    { show: can(user, "notifications.view"), count: queue.failedMessages, label: "Failed customer messages", href: "/admin/notifications?tab=messages&status=failed" },
  ].filter((item) => item.show);

  const kpis: { label: string; value: string; current?: number; previous?: number }[] = [];
  if (summary) {
    const { current, previous } = summary;
    if (money) {
      kpis.push({ label: "Sales", value: formatBdt(current.salesBdt ?? 0), current: current.salesBdt ?? 0, previous: previous.salesBdt ?? 0 });
    }
    kpis.push({ label: "Paid orders", value: String(current.paidOrders), current: current.paidOrders, previous: previous.paidOrders });
    if (money) {
      kpis.push({
        label: "Average order",
        value: current.averageOrderBdt === null ? "—" : formatBdt(current.averageOrderBdt),
        current: current.averageOrderBdt ?? 0,
        previous: previous.averageOrderBdt ?? 0,
      });
    }
    kpis.push({ label: "New customers", value: String(current.newCustomers), current: current.newCustomers, previous: previous.newCustomers });
  }
  kpis.push({ label: "Live products", value: String(catalog.live) });
  if (seesOrders) kpis.push({ label: "In transit", value: String(queue.inTransit) });

  const topUnits = Math.max(1, ...top.map((product) => product.units));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="admin-h1">{greeting}</h1>
          <p className="mt-0.5 text-meta text-ink/70">
            {roleLabel} · the last {days} days, compared with the {days} before.
          </p>
        </div>
        <nav aria-label="Period" className="flex gap-1.5">
          {[7, 30, 90].map((option) => (
            <Link
              key={option}
              href={`/admin?days=${option}`}
              aria-current={days === option ? "true" : undefined}
              className="admin-chip"
            >
              {option} days
            </Link>
          ))}
        </nav>
      </div>

      {params.denied ? (
        <p className="rounded-card border border-brass bg-brass/10 px-3 py-2 text-meta text-ink">
          That section is not part of your role. Ask the owner if you need it.
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="admin-card flex flex-col gap-1 p-3">
            <dt className="admin-kpi-label">{kpi.label}</dt>
            <dd className="admin-kpi-value">{kpi.value}</dd>
            {kpi.current !== undefined && kpi.previous !== undefined ? (
              <dd>
                <Delta current={kpi.current} previous={kpi.previous} />
              </dd>
            ) : null}
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {series ? (
          <section className="admin-card">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="admin-h2">{money ? "Sales per day" : "Paid orders per day"}</h2>
              {can(user, "analytics.view") ? (
                <Link href={`/admin/analytics?days=${days}`} className="text-meta text-blue-600 hover:underline">
                  Analytics
                </Link>
              ) : null}
            </div>
            <div className="mt-3">
              <BarChart
                title={money ? "Sales per day" : "Paid orders per day"}
                points={series.map((point) => ({
                  label: shortDay(point.day),
                  value: money ? (point.salesBdt ?? 0) : point.paidOrders,
                  display: money
                    ? formatBdt(point.salesBdt ?? 0)
                    : `${point.paidOrders} order${point.paidOrders === 1 ? "" : "s"}`,
                }))}
                emptyText="No paid orders in this period."
              />
            </div>
          </section>
        ) : null}

        <section className="admin-card">
          <h2 className="admin-h2">Needs attention</h2>
          {attention.every((item) => item.count === 0) ? (
            <p className="mt-3">
              <StatusBadge tone="positive">Nothing waiting</StatusBadge>
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-blue-100">
              {attention.map((item) => (
                <li key={item.label}>
                  <Link href={item.href} className="flex items-center justify-between gap-3 py-2 text-meta hover:text-blue-600">
                    <span className="text-ink">{item.label}</span>
                    <span
                      className={`inline-flex min-w-7 justify-center rounded-full px-2 py-0.5 text-[0.75rem] font-bold tabular-nums ${
                        item.count > 0 ? "bg-stamp-red-text text-paper" : "bg-blue-50 text-ink/70"
                      }`}
                    >
                      {item.count}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {recent ? (
          <section className="admin-card p-0">
            <div className="flex items-baseline justify-between gap-3 px-4 pt-3">
              <h2 className="admin-h2">Recent orders</h2>
              <Link href="/admin/orders" className="text-meta text-blue-600 hover:underline">
                All orders
              </Link>
            </div>
            {recent.orders.length === 0 ? (
              <p className="px-4 pb-4 pt-2 text-meta text-ink/70">No orders yet.</p>
            ) : (
              <>
              {/* Narrow screens: one row per order, stacked. */}
              <ul className="flex flex-col gap-2 px-3 pb-3 pt-2 md:hidden" aria-label="Recent orders">
                {recent.orders.map((order) => (
                  <li
                    key={order.id}
                    className="flex flex-col gap-1 rounded-card border border-blue-200 p-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/admin/orders/${order.id}`}
                        className="font-semibold tabular-nums text-blue-600"
                      >
                        {order.orderNumber}
                      </Link>
                      <span className="font-semibold tabular-nums text-ink">
                        {formatBdt(order.totalBdt)}
                      </span>
                    </div>
                    <p className="truncate text-[0.75rem] text-ink/70">
                      {order.customerName ?? order.customerEmail ?? "Guest"} ·{" "}
                      {formatShortDate(order.placedAt)}
                    </p>
                    <div className="flex">
                      <StatusBadge tone={orderStatusTone(order.status)}>
                        {ORDER_STATUS_LABELS[order.status] ?? order.status}
                      </StatusBadge>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-2 hidden overflow-x-auto md:block">
                <table className="admin-table min-w-[520px]">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.orders.map((order) => (
                      <tr key={order.id}>
                        <td>
                          <Link href={`/admin/orders/${order.id}`} className="font-semibold tabular-nums text-blue-600 hover:underline">
                            {order.orderNumber}
                          </Link>
                          <span className="block text-ink/70">{formatShortDate(order.placedAt)}</span>
                        </td>
                        <td className="max-w-[14rem] truncate">
                          {order.customerName ?? order.customerEmail ?? "Guest"}
                        </td>
                        <td>
                          <StatusBadge tone={orderStatusTone(order.status)}>
                            {ORDER_STATUS_LABELS[order.status] ?? order.status}
                          </StatusBadge>
                        </td>
                        <td className="text-right font-semibold tabular-nums">{formatBdt(order.totalBdt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </section>
        ) : null}

        <section className="admin-card">
          <h2 className="admin-h2">Top products · {days} days</h2>
          {top.length === 0 ? (
            <p className="mt-2 text-meta text-ink/70">Nothing sold in this period.</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-2.5">
              {top.map((product) => (
                <li key={product.productId ?? product.title} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-meta">
                    <span className="min-w-0 truncate text-ink">{product.title}</span>
                    <span className="shrink-0 tabular-nums text-ink/70">
                      {product.units} sold
                      {product.revenueBdt !== null ? ` · ${formatBdt(product.revenueBdt)}` : ""}
                    </span>
                  </div>
                  <ShareBar share={product.units / topUnits} />
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {stock ? (
          <section className="admin-card">
            <h2 className="admin-h2">Running low</h2>
            {stock.length === 0 ? (
              <p className="mt-3">
                <StatusBadge tone="positive">Stock and batches are healthy</StatusBadge>
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-blue-100">
                {stock.map((alert) => (
                  <li key={`${alert.variantId}-${alert.kind}`} className="flex items-center justify-between gap-3 py-2 text-meta">
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{alert.title}</span>
                      <span className="block font-mono text-[0.6875rem] text-ink/70">{alert.sku}</span>
                    </span>
                    <StatusBadge
                      tone={alert.kind === "out_of_stock" || alert.kind === "preorder_full" ? "negative" : "warning"}
                    >
                      {alert.kind === "out_of_stock"
                        ? "Out of stock"
                        : alert.kind === "low_stock"
                          ? `${alert.remaining} left`
                          : alert.kind === "preorder_full"
                            ? "Batch full"
                            : `${alert.remaining} of ${alert.of} places left`}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {customers ? (
          <section className="admin-card">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="admin-h2">Newest customers</h2>
              <Link href="/admin/customers" className="text-meta text-blue-600 hover:underline">
                All customers
              </Link>
            </div>
            {customers.length === 0 ? (
              <p className="mt-2 text-meta text-ink/70">No customer accounts yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-blue-100">
                {customers.map((customer) => (
                  <li key={customer.id} className="flex items-center justify-between gap-3 py-2 text-meta">
                    <span className="min-w-0">
                      <span className="block truncate text-ink">
                        {[customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.email}
                      </span>
                      <span className="block truncate text-ink/70">{customer.email}</span>
                    </span>
                    <span className="shrink-0 text-ink/70">{formatShortDate(customer.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>

      {seesOrders || money ? (
        <section className="admin-card flex flex-wrap items-center gap-2">
          <h2 className="admin-h2 mr-2">Exports</h2>
          {seesOrders ? (
            <>
              <a href="/api/admin/export?report=orders" className="admin-chip">Orders (CSV)</a>
              <a href="/api/admin/export?report=preorders" className="admin-chip">Preorder capacity (CSV)</a>
            </>
          ) : null}
          {money ? <a href="/api/admin/export?report=margin" className="admin-chip">Margin (CSV)</a> : null}
        </section>
      ) : null}
    </div>
  );
}
