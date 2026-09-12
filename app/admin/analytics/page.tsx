import type { Metadata } from "next";
import Link from "next/link";
import {
  getCategoryPerformance,
  getCustomerInsights,
  getDailySeries,
  getFunnel,
  getPreorderCommitment,
  getSalesSummary,
  getStatusBreakdown,
  getTopProductsInRange,
  lastDays,
  type DateRange,
} from "@/lib/admin";
import { can } from "@/lib/auth";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { formatBdt } from "@/lib/money";
import { BarChart, Delta, ShareBar, shortDay } from "../charts";
import { ORDER_STATUS_LABELS } from "../order-status";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

const PERIODS = [7, 30, 90] as const;

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function parseDay(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * What the business is doing, from what the database records.
 *
 * Money appears only for a role with `finance.view`; everything else is
 * counts. Nothing is estimated: where a figure is not recorded (product
 * views, for one) the page says so instead of inventing it.
 */
export default async function AdminAnalyticsPage({
  searchParams,
}: PageProps<"/admin/analytics">) {
  const user = await requireAdminPage("analytics.view");
  const params = await searchParams;

  const customFrom = parseDay(params.from);
  const customTo = parseDay(params.to);
  const custom = Boolean(customFrom && customTo && customFrom <= customTo);
  const days = PERIODS.includes(Number(params.days) as (typeof PERIODS)[number])
    ? Number(params.days)
    : 30;
  const range: DateRange = custom
    ? { from: customFrom!, to: new Date(customTo!.getTime() + 24 * 60 * 60 * 1000) }
    : lastDays(days);

  const money = can(user, "finance.view");

  const [summary, series, top, categories, customers, funnel, commitment, breakdown] =
    await Promise.all([
      getSalesSummary(user, range),
      getDailySeries(user, range),
      getTopProductsInRange(user, range, 8),
      getCategoryPerformance(user, range),
      getCustomerInsights(user, range),
      getFunnel(user, range),
      getPreorderCommitment(user),
      getStatusBreakdown(user),
    ]);

  const { current, previous } = summary;
  const topUnits = Math.max(1, ...top.map((product) => product.units));
  const categoryUnits = Math.max(1, ...categories.map((row) => row.units));
  const breakdownTotal = breakdown.reduce((sum, row) => sum + row.count, 0);
  const funnelTop = funnel.steps[0]?.value ?? 0;
  const periodLabel = custom
    ? `${params.from} to ${params.to}`
    : `the last ${days} days`;

  const kpis = [
    ...(money
      ? [{ label: "Sales", value: formatBdt(current.salesBdt ?? 0), current: current.salesBdt ?? 0, previous: previous.salesBdt ?? 0 }]
      : []),
    { label: "Paid orders", value: String(current.paidOrders), current: current.paidOrders, previous: previous.paidOrders },
    ...(money
      ? [{
          label: "Average order",
          value: current.averageOrderBdt === null ? "—" : formatBdt(current.averageOrderBdt),
          current: current.averageOrderBdt ?? 0,
          previous: previous.averageOrderBdt ?? 0,
        }]
      : []),
    { label: "Orders placed", value: String(current.placedOrders), current: current.placedOrders, previous: previous.placedOrders },
    { label: "New customers", value: String(current.newCustomers), current: current.newCustomers, previous: previous.newCustomers },
    {
      label: "Repeat buyers",
      value: customers.buyers === 0 ? "—" : percent(customers.repeatBuyers / customers.buyers),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="admin-h1">Analytics</h1>
          <p className="mt-0.5 text-meta text-ink/70">
            {periodLabel}, compared with the same length of time before.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((period) => (
            <Link
              key={period}
              href={`/admin/analytics?days=${period}`}
              aria-current={!custom && days === period ? "true" : undefined}
              className="admin-chip"
            >
              {period} days
            </Link>
          ))}
          <form method="get" className="flex flex-wrap items-center gap-1.5">
            <label className="sr-only" htmlFor="range-from">From</label>
            <input id="range-from" type="date" name="from" defaultValue={custom ? String(params.from) : ""} className="admin-input h-7 min-h-7 text-[0.75rem]" />
            <span className="text-[0.75rem] text-ink/70">to</span>
            <label className="sr-only" htmlFor="range-to">To</label>
            <input id="range-to" type="date" name="to" defaultValue={custom ? String(params.to) : ""} className="admin-input h-7 min-h-7 text-[0.75rem]" />
            <button type="submit" aria-pressed={custom} className="admin-chip">Custom</button>
          </form>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="admin-card flex flex-col gap-1 p-3">
            <dt className="admin-kpi-label">{kpi.label}</dt>
            <dd className="admin-kpi-value">{kpi.value}</dd>
            {"current" in kpi && kpi.current !== undefined ? (
              <dd><Delta current={kpi.current} previous={kpi.previous!} /></dd>
            ) : null}
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {money ? (
          <section className="admin-card">
            <h2 className="admin-h2">Sales per day</h2>
            <p className="text-[0.75rem] text-ink/70">Paid order value, by the day it was placed.</p>
            <div className="mt-3">
              <BarChart
                title="Sales per day"
                points={series.map((point) => ({ label: shortDay(point.day), value: point.salesBdt ?? 0, display: formatBdt(point.salesBdt ?? 0) }))}
              />
            </div>
          </section>
        ) : null}
        <section className="admin-card">
          <h2 className="admin-h2">Orders per day</h2>
          <p className="text-[0.75rem] text-ink/70">Every order placed, paid or not.</p>
          <div className="mt-3">
            <BarChart
              title="Orders per day"
              points={series.map((point) => ({ label: shortDay(point.day), value: point.orders, display: `${point.orders} order${point.orders === 1 ? "" : "s"}` }))}
            />
          </div>
        </section>
        <section className="admin-card">
          <h2 className="admin-h2">New customers per day</h2>
          <p className="text-[0.75rem] text-ink/70">
            {customers.totalCustomers} accounts in all · {customers.buyers} have bought · {customers.repeatBuyers} more than once
          </p>
          <div className="mt-3">
            <BarChart
              title="New customers per day"
              points={series.map((point) => ({ label: shortDay(point.day), value: point.signups, display: `${point.signups} sign-up${point.signups === 1 ? "" : "s"}` }))}
              emptyText="No one registered in this period."
            />
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="admin-card">
          <h2 className="admin-h2">Top products</h2>
          {top.length === 0 ? (
            <p className="mt-2 text-meta text-ink/70">Nothing sold in this period.</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-2.5">
              {top.map((product) => (
                <li key={product.productId ?? product.title} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-meta">
                    <span className="min-w-0 truncate text-ink">{product.title}</span>
                    <span className="shrink-0 tabular-nums text-ink/70">
                      {product.units} units · {product.orders} order{product.orders === 1 ? "" : "s"}
                      {product.revenueBdt !== null ? ` · ${formatBdt(product.revenueBdt)}` : ""}
                    </span>
                  </div>
                  <ShareBar share={product.units / topUnits} />
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="admin-card">
          <h2 className="admin-h2">By category</h2>
          {categories.length === 0 ? (
            <p className="mt-2 text-meta text-ink/70">Nothing sold in this period.</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-2.5">
              {categories.map((row) => (
                <li key={row.categoryId ?? row.name} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-meta">
                    <span className="text-ink">{row.name}</span>
                    <span className="tabular-nums text-ink/70">
                      {row.units} units{row.revenueBdt !== null ? ` · ${formatBdt(row.revenueBdt)}` : ""}
                    </span>
                  </div>
                  <ShareBar share={row.units / categoryUnits} />
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="admin-card">
          <h2 className="admin-h2">Purchase funnel</h2>
          <ul className="mt-2 flex flex-col gap-2.5">
            {funnel.steps.map((step) => (
              <li key={step.label} className="flex flex-col gap-1">
                <div className="flex justify-between gap-3 text-meta">
                  <span className="text-ink">{step.label}</span>
                  <span className="tabular-nums text-ink/70">
                    {step.value}
                    {step.conversionFromPrevious !== null ? ` · ${percent(step.conversionFromPrevious)}` : ""}
                  </span>
                </div>
                <ShareBar share={funnelTop === 0 ? 0 : step.value / funnelTop} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.75rem] text-ink/70">Not recorded yet: {funnel.missing.map((item) => item.split(" — ")[0]).join(", ")}.</p>
        </section>

        <section className="admin-card">
          <h2 className="admin-h2">Preorder performance</h2>
          <dl className="mt-2 flex flex-col gap-1.5 text-meta">
            <div className="flex justify-between gap-3"><dt className="text-ink/70">Places offered</dt><dd className="tabular-nums">{commitment.totalCapacity}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink/70">Places taken</dt><dd className="tabular-nums">{commitment.totalReserved}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink/70">Utilisation</dt><dd className="tabular-nums">{percent(commitment.utilisation)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink/70">Batches full</dt><dd className="tabular-nums">{commitment.fullVariants}</dd></div>
          </dl>
          <div className="mt-3"><ShareBar share={commitment.utilisation} /></div>
        </section>

        <section className="admin-card">
          <h2 className="admin-h2">Orders by stage, now</h2>
          {breakdown.length === 0 ? (
            <p className="mt-2 text-meta text-ink/70">No orders yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {breakdown.map((row) => (
                <li key={row.status} className="flex flex-col gap-1">
                  <div className="flex justify-between gap-3 text-meta">
                    <span className="text-ink">{ORDER_STATUS_LABELS[row.status] ?? row.status}</span>
                    <span className="tabular-nums text-ink/70">{row.count}</span>
                  </div>
                  <ShareBar share={breakdownTotal === 0 ? 0 : row.count / breakdownTotal} />
                </li>
              ))}
            </ul>
          )}
          {customers.accountOrderShare !== null ? (
            <p className="mt-3 text-[0.75rem] text-ink/70">
              {percent(customers.accountOrderShare)} of paid orders in this period came from signed-in accounts.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
