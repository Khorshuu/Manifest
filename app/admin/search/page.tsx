import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { formatShortDate } from "@/lib/format";
import { searchReport } from "@/lib/search/analytics";
import { searchIndexStatus } from "@/lib/search/maintenance";
import { listSynonyms } from "@/lib/search/synonyms";
import { ReindexButton } from "./reindex-button";
import { SynonymManager } from "./synonym-manager";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: "Search" };
export const dynamic = "force-dynamic";

const PERIODS = [7, 30, 90] as const;

/**
 * What people search for, what they could not find, the synonyms that teach
 * the search a shop's own vocabulary, and the state of the index.
 *
 * Every figure is a query over recorded searches. A period with no searches
 * says so rather than showing zeros dressed as a trend (CLAUDE.md section 7).
 */
export default async function AdminSearchPage({
  searchParams,
}: PageProps<"/admin/search">) {
  const params = await searchParams;
  const requested = Number(params.days);
  const days = (PERIODS as readonly number[]).includes(requested) ? requested : 30;
  const prefill = typeof params.term === "string" ? params.term.slice(0, 60) : "";

  const user = await requireAdminPage("search.manage");
  const [report, status, synonyms] = await Promise.all([
    searchReport(user, days),
    searchIndexStatus(user),
    listSynonyms(user),
  ]);

  const percent = (value: number | null) =>
    value === null ? "—" : `${Math.round(value * 100)}%`;

  const tiles = [
    { label: "Searches", value: report.searches.toLocaleString("en-GB") },
    { label: "Visitors who searched", value: report.visitors.toLocaleString("en-GB") },
    {
      label: "Found nothing",
      value:
        report.searches === 0
          ? "—"
          : `${report.zeroResultSearches.toLocaleString("en-GB")} · ${percent(
              report.zeroResultSearches / report.searches,
            )}`,
    },
    { label: "Followed by a click", value: percent(report.clickThroughRate) },
  ];

  /* Three things, each load-bearing: `min-w-0` so the box does not grow to
     the width of the table it holds, the scroll so the table can be wider
     than the phone, and `relative` so the screen-reader-only labels inside
     (which are absolutely positioned) are clipped by the box too — otherwise
     one of them sat at 375px on a 320px screen and took the page with it. */
  const tableShell =
    "relative min-w-0 max-w-full overflow-x-auto rounded-card border border-blue-300 shadow-[var(--shadow-raise)]";
  const th = "px-4 py-3 text-meta font-medium";
  const td = "border-t border-blue-300 px-4 py-3";

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <div>
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Discovery
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Search</h1>
        <p className="mt-2 max-w-[70ch] text-body text-ink/70">
          What shoppers look for and what they fail to find. A search that
          found nothing is usually a word the listings do not use — add it as a
          synonym here, or as a keyword on the product.
        </p>
      </div>

      <section aria-labelledby="search-activity">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="search-activity" className="font-display text-h2 text-ink">
            Activity
          </h2>
          <nav aria-label="Period" className="flex gap-1">
            {PERIODS.map((period) => (
              <Link
                key={period}
                href={`/admin/search?days=${period}`}
                aria-current={period === days ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-control px-3 text-meta font-medium transition-colors ${
                  period === days
                    ? "bg-ink text-paper"
                    : "border border-blue-300 bg-paper text-blue-600 hover:bg-blue-50"
                }`}
              >
                {period} days
              </Link>
            ))}
          </nav>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((tile) => (
            <div
              key={tile.label}
              className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
            >
              <dt className="text-meta text-ink/70">{tile.label}</dt>
              <dd className="mt-2 font-display text-h2 tabular-nums text-ink">
                {tile.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid gap-10 xl:grid-cols-2">
        <section aria-labelledby="top-searches" className="min-w-0">
          <h2 id="top-searches" className="font-display text-h3 text-ink">
            Most searched
          </h2>
          {report.top.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                title="No searches yet"
                body={`Nobody has searched in the last ${days} days. This fills in as shoppers use the search box.`}
              />
            </div>
          ) : (
            <div className={`mt-4 ${tableShell}`}>
              <table className="w-full min-w-[520px] border-collapse text-body">
                <thead>
                  <tr className="bg-paper text-left">
                    <th scope="col" className={th}>Search</th>
                    <th scope="col" className={`${th} text-right`}>Searches</th>
                    <th scope="col" className={`${th} text-right`}>People</th>
                    <th scope="col" className={`${th} text-right`}>Avg. results</th>
                    <th scope="col" className={`${th} text-right`}>Clicks</th>
                  </tr>
                </thead>
                <tbody>
                  {report.top.map((row, index) => (
                    <tr key={row.query} className={index % 2 === 1 ? "bg-blue-200/40" : undefined}>
                      <td className={td}>
                        <Link
                          href={`/search?q=${encodeURIComponent(row.query)}`}
                          className="text-blue-600 hover:underline [overflow-wrap:anywhere]"
                        >
                          {row.query}
                        </Link>
                      </td>
                      <td className={`${td} text-right tabular-nums`}>{row.searches}</td>
                      <td className={`${td} text-right tabular-nums`}>{row.visitors}</td>
                      <td className={`${td} text-right tabular-nums`}>{row.averageResults}</td>
                      <td className={`${td} text-right tabular-nums`}>{row.clicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="zero-results" className="min-w-0">
          <h2 id="zero-results" className="font-display text-h3 text-ink">
            Searches that found nothing
          </h2>
          {report.zeroResults.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                title="Nothing unanswered"
                body={`Every search in the last ${days} days found something.`}
              />
            </div>
          ) : (
            <div className={`mt-4 ${tableShell}`}>
              <table className="w-full min-w-[520px] border-collapse text-body">
                <thead>
                  <tr className="bg-paper text-left">
                    <th scope="col" className={th}>Search</th>
                    <th scope="col" className={`${th} text-right`}>Times</th>
                    <th scope="col" className={th}>Last</th>
                    <th scope="col" className={th}>
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.zeroResults.map((row, index) => (
                    <tr key={row.query} className={index % 2 === 1 ? "bg-blue-200/40" : undefined}>
                      <td className={`${td} [overflow-wrap:anywhere]`}>{row.query}</td>
                      <td className={`${td} text-right tabular-nums`}>{row.searches}</td>
                      <td className={`${td} text-ink/80`}>{formatShortDate(row.lastSearchedAt)}</td>
                      <td className={td}>
                        <Link
                          href={`/admin/search?days=${days}&term=${encodeURIComponent(row.query)}#synonyms`}
                          className="whitespace-nowrap text-meta font-semibold text-blue-600 hover:underline"
                        >
                          Add a synonym
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section id="synonyms" aria-labelledby="synonyms-heading" className="scroll-mt-28">
        <h2 id="synonyms-heading" className="font-display text-h2 text-ink">
          Synonyms
        </h2>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          Words that should find the same products. A two-way entry works both
          ways — “earbuds” and “earphones”. A one-way entry only widens the
          first word — “cellphone” also finds “phone”, but a search for “phone”
          is left alone. Changes apply to the next search; nothing needs
          rebuilding.
        </p>
        <div className="mt-4">
          <SynonymManager initial={synonyms} prefillTerm={prefill} />
        </div>
      </section>

      <section aria-labelledby="index-heading">
        <h2 id="index-heading" className="font-display text-h2 text-ink">
          Search index
        </h2>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          The database keeps this in step on its own: a product is re-indexed
          when anything it is searched by changes — its words, its variants,
          its category, its specifications. Rebuilding is only ever needed
          after a change to how the index itself is built.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Products", value: status.products },
            { label: "Indexed", value: status.indexed },
            { label: "Not indexed", value: status.missing },
            { label: "Waiting to retry", value: status.queued },
          ].map((tile) => (
            <div
              key={tile.label}
              className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
            >
              <dt className="text-meta text-ink/70">{tile.label}</dt>
              <dd className="mt-2 font-display text-h2 tabular-nums text-ink">
                {tile.value.toLocaleString("en-GB")}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-meta text-ink/70">
          {status.lastIndexedAt
            ? `Last change indexed ${formatShortDate(status.lastIndexedAt)}.`
            : "Nothing indexed yet."}
        </p>
        <div className="mt-4">
          <ReindexButton />
        </div>
      </section>

      <section aria-labelledby="not-measured">
        <h2 id="not-measured" className="font-display text-h3 text-ink">
          Not measured yet
        </h2>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-meta text-ink/70">
          {report.missing.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
