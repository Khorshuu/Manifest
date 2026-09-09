import type { Metadata } from "next";
import Link from "next/link";
import {
  getFunnel,
  getPreorderCommitment,
  getRevenueByDay,
  getSignupsByDay,
  getStatusBreakdown,
  lastDays,
} from "@/lib/admin";
import { getCurrentUser, isSuperAdmin } from "@/lib/auth";
import { formatBdt } from "@/lib/money";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

const PERIODS = [7, 30, 90] as const;

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * A horizontal bar, drawn with a plain div rather than a charting library.
 * One dependency fewer is worth more here than a rendered axis.
 *
 * The fill sits in a track rather than floating on the page: without one, a
 * short bar and a missing bar look the same, and the row loses the sense of
 * how much of the whole it represents. The figure itself is printed in the
 * row heading above, so it is not repeated at the end of the bar.
 */
function Bar({ share }: { share: number }) {
  const width = Math.max(1.5, Math.round(share * 100));

  return (
    <div
      className="h-2.5 w-full overflow-hidden rounded-card bg-blue-200"
      role="presentation"
    >
      <div
        className="h-full rounded-card bg-blue-600"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export default async function AdminAnalyticsPage({
  searchParams,
}: PageProps<"/admin/analytics">) {
  const params = await searchParams;
  const days = PERIODS.includes(Number(params.days) as (typeof PERIODS)[number])
    ? Number(params.days)
    : 30;

  const range = lastDays(days);
  const user = await getCurrentUser();
  const showFinancials = isSuperAdmin(user);

  const [funnel, commitment, signups, breakdown, revenue] = await Promise.all([
    getFunnel(user, range),
    getPreorderCommitment(user),
    getSignupsByDay(user, range),
    getStatusBreakdown(user),
    showFinancials ? getRevenueByDay(user, range) : Promise.resolve(null),
  ]);

  const funnelTop = funnel.steps[0]?.value ?? 0;
  const revenueTotal =
    revenue?.reduce((sum, point) => sum + point.collectedBdt, 0) ?? 0;
  const revenuePeak = Math.max(
    1,
    ...(revenue?.map((point) => point.collectedBdt) ?? [1]),
  );
  const breakdownTotal = breakdown.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Operations
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Analytics</h1>
      </div>

      {/* One control rather than three loose buttons: the choices are
          mutually exclusive, so they read better as segments of one thing. */}
      <nav aria-label="Reporting period">
        <ul className="inline-flex flex-wrap gap-1 rounded-control border border-blue-300 bg-paper-raised p-1">
          {PERIODS.map((period) => (
            <li key={period}>
              <Link
                href={`/admin/analytics?days=${period}`}
                aria-current={days === period ? "page" : undefined}
                className={`inline-flex min-h-9 items-center rounded-control px-3 text-meta transition-colors ${
                  days === period
                    ? "bg-paper font-medium text-ink shadow-[var(--shadow-raise)]"
                    : "text-ink/70 hover:bg-paper/70 hover:text-ink"
                }`}
              >
                Last {period} days
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className="rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)] sm:p-6">
        <h2 className="font-display text-h2 text-ink">Funnel</h2>

        <ul className="mt-4 flex flex-col gap-4">
          {funnel.steps.map((step) => (
            <li key={step.label} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="text-body text-ink">{step.label}</span>
                <span className="text-meta tabular-nums text-ink/70">
                  {step.value}
                  {step.conversionFromPrevious !== null
                    ? ` · ${percent(step.conversionFromPrevious)} of the step above`
                    : ""}
                </span>
              </div>
              <Bar share={funnelTop === 0 ? 0 : step.value / funnelTop} />
            </li>
          ))}
        </ul>

        {/* Saying what is missing is part of the report. */}
        {funnel.missing.length > 0 ? (
          <div className="surface-paper mt-6 rounded-card border border-blue-300 p-4">
            <p className="text-meta font-medium text-ink">
              Not measured yet
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {funnel.missing.map((item) => (
                <li key={item} className="text-meta text-ink/70">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {revenue ? (
        <section className="rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)] sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="font-display text-h2 text-ink">Revenue</h2>
            <p className="text-body tabular-nums text-ink">
              {formatBdt(revenueTotal)} collected
            </p>
          </div>

          {revenue.length === 0 ? (
            <p className="mt-4 text-body text-ink/70">
              Nothing was collected in this period.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {revenue.map((point) => (
                <li key={point.day} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="text-meta tabular-nums text-ink/70">
                      {point.day}
                    </span>
                    <span className="text-meta tabular-nums text-ink">
                      {formatBdt(point.collectedBdt)} · {point.orderCount} order
                      {point.orderCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <Bar share={point.collectedBdt / revenuePeak} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="min-w-0 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)] sm:p-6">
          <h2 className="font-display text-h2 text-ink">Preorder commitment</h2>
          <dl className="mt-4 flex flex-col gap-2 text-body">
            <div className="flex justify-between gap-4">
              <dt className="text-ink/70">Capacity offered</dt>
              <dd className="tabular-nums text-ink">
                {commitment.totalCapacity}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink/70">Slots taken</dt>
              <dd className="tabular-nums text-ink">
                {commitment.totalReserved}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink/70">Utilisation</dt>
              <dd className="tabular-nums text-ink">
                {percent(commitment.utilisation)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink/70">Variants now full</dt>
              <dd className="tabular-nums text-ink">
                {commitment.fullVariants}
              </dd>
            </div>
          </dl>
        </section>

        <section className="min-w-0 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)] sm:p-6">
          <h2 className="font-display text-h2 text-ink">Orders by stage</h2>
          {breakdown.length === 0 ? (
            <p className="mt-4 text-body text-ink/70">No orders yet.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-3">
              {breakdown.map((row) => (
                <li key={row.status} className="flex flex-col gap-1">
                  <div className="flex justify-between gap-3">
                    <span className="text-meta text-ink">
                      {row.status.replace(/_/g, " ")}
                    </span>
                    <span className="text-meta tabular-nums text-ink/70">
                      {row.count}
                    </span>
                  </div>
                  <Bar share={breakdownTotal === 0 ? 0 : row.count / breakdownTotal} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)] sm:p-6">
        <h2 className="font-display text-h2 text-ink">New customers</h2>
        {signups.length === 0 ? (
          <p className="mt-4 text-body text-ink/70">
            No one registered in this period.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {signups.map((point) => (
              <li
                key={point.day}
                className="flex justify-between gap-3 border-b border-blue-300 py-2"
              >
                <span className="text-meta tabular-nums text-ink/70">
                  {point.day}
                </span>
                <span className="text-meta tabular-nums text-ink">
                  {point.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
