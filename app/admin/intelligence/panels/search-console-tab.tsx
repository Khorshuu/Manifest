import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { can } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { formatShortDate } from "@/lib/format";
import {
  changeComparisons,
  learningSignals,
  metricsStorage,
  opportunityReport,
  searchConsoleStatus,
} from "@/lib/search-console";
import { changeFieldLabel } from "@/lib/seo/history";
import { SearchConsolePanel } from "@/app/admin/seo-performance/search-console-panel";
import { Section, TabHeading } from "../ui";

/**
 * The Search Console tab: what Google reports about this shop&rsquo;s pages,
 * and what the measurements say is worth doing (D-096 to D-100).
 *
 * Search Console is optional and the workspace does not pretend otherwise. If
 * nothing is connected the tab says so, explains what connecting would add,
 * and shows nothing invented in the meantime — the SEO change history below
 * still works, because it is recorded by Manifest rather than fetched from
 * Google. Every figure is a sum over stored measurements, and a rise after a
 * change is an observation about a period, never a cause.
 *
 * The semantics are unchanged: this is the existing Search performance screen
 * rendered inside the workspace, with the same loaders and the same split
 * between reading (`seo.view`) and acting (`catalog.manage`).
 */
export async function SearchConsoleTab({ user }: { user: SessionUser }) {
  // Reading this tab needs `seo.view`; acting on it needs `catalog.manage`
  // (D-101). The actions re-check that permission inside `lib/`, so a
  // read-only viewer who forges the request is still refused.
  const canManage = can(user, "catalog.manage");
  const [status, storage] = await Promise.all([searchConsoleStatus(user), metricsStorage(user)]);

  const connected = status.state !== "not_configured";
  const [report, comparisons, learning] = connected
    ? await Promise.all([
        opportunityReport(user),
        changeComparisons(user, { limit: 15 }),
        learningSignals(user),
      ])
    : [null, await changeComparisons(user, { limit: 15 }), null];

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <TabHeading title="Search Console">
        What Google reports about these pages, and what those numbers say is worth doing. Nothing here is estimated:
        search volume, keyword difficulty and competitor figures are not measurements this shop has, so they are not
        shown.
      </TabHeading>

      <SearchConsolePanel
        status={status}
        report={report}
        learning={learning}
        storage={storage}
        canManage={canManage}
      />

      <Section
        id="changes"
        title="SEO changes, and what happened after"
        description="Every change to a listing’s or a shelf’s SEO fields, with the measurements either side of it where there are enough. A rise after a change is an observation about the period, not proof the change caused it — traffic moves with the season, with stock and with whatever Google changed that week. This history is recorded by Manifest, so it works whether or not Search Console is connected."
      >
        {comparisons.comparisons.length === 0 ? (
          <EmptyState
            title="No SEO changes recorded yet"
            body="A change to a listing's or shelf's SEO fields appears here with its before and after."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {comparisons.comparisons.map((row) => (
              <li key={row.change.id} className="admin-card p-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="admin-h2 [overflow-wrap:anywhere]">
                    {row.change.path ? (
                      <Link
                        href={
                          row.change.entityType === "product"
                            ? `/admin/products/${row.change.entityId}`
                            : "/admin/categories"
                        }
                        className="text-blue-600 hover:underline"
                      >
                        {row.change.entityName}
                      </Link>
                    ) : (
                      row.change.entityName
                    )}
                  </p>
                  <span className="admin-chip">{changeFieldLabel(row.change.field)}</span>
                </div>

                <p className="mt-1 text-[0.75rem] tabular-nums text-ink/60">
                  {formatShortDate(row.change.changedAt)} · {row.change.actor ?? "no recorded actor"} ·{" "}
                  {row.change.workflow.replace(/_/g, " ")}
                </p>

                <dl className="mt-3 grid gap-2 text-[0.8125rem] sm:grid-cols-2">
                  <div>
                    <dt className="text-ink/55">Before</dt>
                    <dd className="text-ink [overflow-wrap:anywhere]">{row.change.beforeValue || "(empty)"}</dd>
                  </div>
                  <div>
                    <dt className="text-ink/55">After</dt>
                    <dd className="text-ink [overflow-wrap:anywhere]">{row.change.afterValue || "(empty)"}</dd>
                  </div>
                </dl>

                <p className="mt-3 text-[0.8125rem] text-ink">{row.observation}</p>
                <p className="mt-1 text-[0.75rem] text-ink/55">
                  Observed association only; causation {row.causation}. Other things that move these numbers:{" "}
                  {row.confounders.join(" ").toLowerCase()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
