import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { can } from "@/lib/auth/authorize";
import { formatShortDate } from "@/lib/format";
import {
  changeComparisons,
  learningSignals,
  metricsStorage,
  opportunityReport,
  searchConsoleStatus,
} from "@/lib/search-console";
import { changeFieldLabel } from "@/lib/seo/history";
import { SearchConsolePanel } from "./search-console-panel";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Search performance" };

/**
 * What Google reports about this shop's pages, and what the measurements say
 * is worth doing (D-096 to D-100).
 *
 * The page works with Search Console not connected: it says so, explains what
 * connecting would add, and shows nothing invented in the meantime. Every
 * figure below is a sum over stored measurements, and every opportunity is a
 * rule over those sums with its numbers shown.
 */
export default async function SeoPerformancePage() {
  // Reading this screen needs `seo.view`; acting on it needs `catalog.manage`
  // (D-101). The actions re-check that permission inside `lib/`, so a
  // read-only viewer who forges the request is still refused.
  const user = await requireAdminPage("seo.view");
  const canManage = can(user, "catalog.manage");
  const [status, storage] = await Promise.all([searchConsoleStatus(user), metricsStorage(user)]);

  const connected = status.state !== "not_configured";
  const [report, comparisons, learning] = connected
    ? await Promise.all([opportunityReport(user), changeComparisons(user, { limit: 15 }), learningSignals(user)])
    : [null, await changeComparisons(user, { limit: 15 }), null];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-h2 text-ink">Search performance</h1>
        <p className="max-w-2xl text-body text-ink/70">
          What Google reports about these pages, and what those numbers say is worth doing. Nothing here is estimated:
          search volume, keyword difficulty and competitor figures are not measurements this shop has, so they are not
          shown. What was changed and when comes from the SEO change history, which works whether or not Search Console
          is connected.
        </p>
      </header>

      <SearchConsolePanel status={status} report={report} learning={learning} storage={storage} canManage={canManage} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-h3 text-ink">SEO changes, and what happened after</h2>
          <p className="max-w-2xl text-body text-ink/70">
            Every change to a listing&rsquo;s or a shelf&rsquo;s SEO fields, with the measurements either side of it
            where there are enough. A rise after a change is an observation about the period, not proof the change
            caused it — traffic moves with the season, with stock and with whatever Google changed that week.
          </p>
        </div>

        {comparisons.comparisons.length === 0 ? (
          <EmptyState title="No SEO changes recorded yet" body="A change to a listing's or shelf's SEO fields appears here with its before and after." />
        ) : (
          <ul className="flex flex-col gap-3">
            {comparisons.comparisons.map((row) => (
              <li key={row.change.id} className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-display text-h3 text-ink [overflow-wrap:anywhere]">
                    {row.change.path ? (
                      <Link
                        href={row.change.entityType === "product" ? `/admin/products/${row.change.entityId}` : "/admin/categories"}
                        className="text-blue-600 hover:underline"
                      >
                        {row.change.entityName}
                      </Link>
                    ) : (
                      row.change.entityName
                    )}
                  </p>
                  <span className="inline-flex items-center rounded-control bg-blue-200/60 px-2 py-1 text-meta font-medium text-ink">
                    {changeFieldLabel(row.change.field)}
                  </span>
                </div>

                <p className="mt-1 text-meta text-ink/70 tabular-nums">
                  {formatShortDate(row.change.changedAt)} · {row.change.actor ?? "no recorded actor"} ·{" "}
                  {row.change.workflow.replace(/_/g, " ")}
                </p>

                <dl className="mt-3 grid gap-2 text-meta sm:grid-cols-2">
                  <div>
                    <dt className="text-ink/55">Before</dt>
                    <dd className="text-ink [overflow-wrap:anywhere]">{row.change.beforeValue || "(empty)"}</dd>
                  </div>
                  <div>
                    <dt className="text-ink/55">After</dt>
                    <dd className="text-ink [overflow-wrap:anywhere]">{row.change.afterValue || "(empty)"}</dd>
                  </div>
                </dl>

                <p className="mt-3 text-body text-ink">{row.observation}</p>
                <p className="mt-1 text-meta text-ink/55">
                  Observed association only; causation {row.causation}. Other things that move these numbers:{" "}
                  {row.confounders.join(" ").toLowerCase()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-meta text-ink/55">
        Catalogue-wide SEO checks are on the{" "}
        <Link href="/admin/seo-health" className="text-blue-600 hover:underline">
          SEO health
        </Link>{" "}
        screen.
      </p>
    </div>
  );
}
