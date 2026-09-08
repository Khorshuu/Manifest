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
 * The design system asks for borders over decoration, and one dependency
 * fewer is worth more here than a rendered axis.
 */
function Bar({ share, label }: { share: number; label: string }) {
  const width = Math.max(2, Math.round(share * 100));

  return (
    <div className="flex items-center gap-3">
      <div
        className="h-3 rounded-none bg-blue-400"
        style={{ width: `${width}%` }}
        role="presentation"
      />
      <span className="text-meta tabular-nums text-ink/70">{label}</span>
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
    <div className="flex flex-col gap-10">
      <div>
        <p className="text-meta text-blue-600">Operations</p>
        <h1 className="mt-2 font-display text-h1 text-ink">Analytics</h1>
      </div>

      <nav aria-label="Reporting period">
        <ul className="flex flex-wrap gap-2">
          {PERIODS.map((period) => (
            <li key={period}>
              <Link
                href={`/admin/analytics?days=${period}`}
                aria-current={days === period ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-control border px-3 text-meta ${
                  days === period
                    ? "border-blue-600 text-blue-600"
                    : "border-blue-300 text-ink"
                }`}
              >
                Last {period} days
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section>
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
              <Bar
                share={funnelTop === 0 ? 0 : step.value / funnelTop}
                label={String(step.value)}
              />
            </li>
          ))}
        </ul>

        {/* Saying what is missing is part of the report. */}
        {funnel.missing.length > 0 ? (
          <div className="mt-6 border border-blue-300 p-4">
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
        <section>
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
                  <Bar
                    share={point.collectedBdt / revenuePeak}
                    label={formatBdt(point.collectedBdt)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-2">
        <section className="min-w-0">
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

        <section className="min-w-0">
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
                  <Bar
                    share={breakdownTotal === 0 ? 0 : row.count / breakdownTotal}
                    label={String(row.count)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section>
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
