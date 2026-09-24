import Link from "next/link";
import { formatShortDate } from "@/lib/format";
import type { ListingPerformance } from "@/lib/search-console/listing";
import { changeFieldLabel } from "@/lib/seo/history";

/**
 * What Google reports about this one page, and what changed here (D-096,
 * D-098, D-099).
 *
 * With Search Console not connected the box still earns its place: the SEO
 * change history is this shop's own record and works regardless. What it never
 * does is fill the gap with an estimate.
 */
export function SearchPerformanceBox({ performance }: { performance: ListingPerformance }) {
  const { totals, window } = performance;

  return (
    <section className="flex flex-col gap-3 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
      <div className="flex flex-col gap-1">
        <h2 className="text-meta font-medium text-ink">Search performance</h2>
        {!performance.connected ? (
          <p className="text-meta text-ink/65">
            Search Console not connected. The changes below are this shop&rsquo;s own record; how Google reports this
            page would come from a connected property.
          </p>
        ) : !window ? (
          <p className="text-meta text-ink/65">Connected, but nothing has been synced yet.</p>
        ) : (
          <p className="text-meta text-ink/65">
            {window.start} to {window.end}.
          </p>
        )}
      </div>

      {totals && window ? (
        <dl className="grid grid-cols-2 gap-2 text-meta">
          <div>
            <dt className="text-ink/55">Clicks</dt>
            <dd className="text-ink tabular-nums">{totals.clicks.toLocaleString("en-GB")}</dd>
          </div>
          <div>
            <dt className="text-ink/55">Impressions</dt>
            <dd className="text-ink tabular-nums">{totals.impressions.toLocaleString("en-GB")}</dd>
          </div>
          <div>
            <dt className="text-ink/55">Clicked</dt>
            <dd className="text-ink tabular-nums">{(totals.ctr * 100).toFixed(2)}%</dd>
          </div>
          <div>
            <dt className="text-ink/55">Average position</dt>
            <dd className="text-ink tabular-nums">{totals.position != null ? totals.position.toFixed(1) : "—"}</dd>
          </div>
        </dl>
      ) : null}

      {performance.topQueries.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-blue-300 pt-2">
          <p className="text-meta font-medium text-ink">Searches this page is shown for</p>
          <ul className="flex flex-col gap-1 text-meta text-ink/65">
            {performance.topQueries.map((row) => (
              <li key={row.query} className="flex justify-between gap-2">
                <span className="[overflow-wrap:anywhere]">{row.query}</span>
                <span className="shrink-0 tabular-nums">
                  {row.clicks}/{row.impressions}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {performance.changes.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-blue-300 pt-2">
          <p className="text-meta font-medium text-ink">Recent SEO changes</p>
          {performance.changes.map((change) => {
            // With Search Console connected each change carries what the
            // measurements did around it; without it, the change alone.
            const comparison = performance.comparisons.find((row) => row.change.id === change.id);
            return (
              <div key={change.id} className="flex flex-col gap-0.5">
                <p className="text-meta text-ink">
                  {changeFieldLabel(change.field)} · {formatShortDate(change.changedAt)} · {change.actor ?? "no recorded actor"}
                </p>
                {comparison ? <p className="text-meta text-ink/65">{comparison.observation}</p> : null}
              </div>
            );
          })}
          {performance.comparisons.length > 0 ? (
            <p className="text-meta text-ink/45">Observed association only; causation not established.</p>
          ) : null}
        </div>
      ) : null}

      <p className="text-meta">
        <Link href="/admin/intelligence/search-console" className="text-blue-600 hover:underline">
          All Search Console reporting
        </Link>
      </p>
    </section>
  );
}
