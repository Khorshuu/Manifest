import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { can } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { formatShortDate } from "@/lib/format";
import { searchReport } from "@/lib/search/analytics";
import { searchIndexStatus } from "@/lib/search/maintenance";
import { listSynonyms } from "@/lib/search/synonyms";
import { zeroResultIntelligence } from "@/lib/search/zero-results";
import { ReindexButton } from "@/app/admin/search/reindex-button";
import { SynonymManager } from "@/app/admin/search/synonym-manager";
import { ZeroResultIntelligence } from "@/app/admin/search/zero-results";
import { SEARCH_PERIODS } from "../filters";
import { Metric, MetricGrid, Section, TabHeading, TableShell } from "../ui";

/**
 * The SearchPulse tab: this shop&rsquo;s own search, not Google&rsquo;s.
 *
 * What shoppers look for, what they fail to find and why, the vocabulary that
 * teaches the search a shop&rsquo;s own words, and the state of the index. It
 * is the existing Search screen, rendered inside the workspace — the same
 * loaders, the same controls, the same permissions. No ranking rule and no
 * part of the search data model is touched by this view.
 */

export async function SearchPulsePanel({
  user,
  basePath,
  days,
  prefillTerm = "",
}: {
  user: SessionUser;
  /** Which route the period links and the synonym link point back at. */
  basePath: "/admin/search" | "/admin/intelligence/searchpulse";
  days: number;
  prefillTerm?: string;
}) {
  const [report, status, synonyms, zeroResults] = await Promise.all([
    searchReport(user, days),
    searchIndexStatus(user),
    listSynonyms(user),
    zeroResultIntelligence(user, { days }),
  ]);
  // Recording vocabulary is a catalogue permission, not a search one: somebody
  // who may read the report is not automatically somebody who may name things.
  // The API checks it again — this only decides whether to offer the button.
  const canSuggestAliases = can(user, "catalog.manage");

  const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <TabHeading
        title="SearchPulse"
        actions={
          <nav aria-label="Period" className="flex gap-1">
            {SEARCH_PERIODS.map((period) => (
              <Link
                key={period}
                href={`${basePath}?days=${period}`}
                aria-current={period === days ? "true" : undefined}
                className="admin-chip"
              >
                {period} days
              </Link>
            ))}
          </nav>
        }
      >
        What shoppers look for on this site and what they fail to find. A search that found nothing is usually a word
        the listings do not use — add it as a synonym here, or as a keyword on the product.
      </TabHeading>

      <MetricGrid>
        <Metric label="Searches" value={report.searches} note={`last ${days} days`} />
        <Metric label="People who searched" value={report.visitors} />
        <Metric
          label="Found nothing"
          value={
            report.searches === 0
              ? "—"
              : `${report.zeroResultSearches.toLocaleString("en-GB")} · ${percent(
                  report.zeroResultSearches / report.searches,
                )}`
          }
          tone={report.zeroResultSearches > 0 ? "attention" : "plain"}
          href={`${basePath}?days=${days}#zero-results`}
        />
        <Metric label="Followed by a click" value={percent(report.clickThroughRate)} />
        <Metric label="Then filtered" value={percent(report.filterRate)} />
        <Metric label="Rephrased" value={percent(report.refinementRate)} />
        <Metric label="Added to a cart" value={report.addToCartSearches} />
        <Metric
          label="Paid for"
          value={
            report.convertedSearches === 0
              ? "—"
              : `${report.convertedSearches.toLocaleString("en-GB")} · ${report.convertedUnits.toLocaleString(
                  "en-GB",
                )} units`
          }
        />
      </MetricGrid>

      <Section
        id="zero-results"
        title="Searches that found nothing"
        description="Each one says what is actually wrong. Four of the seven verdicts are not search faults at all — an empty shelf, a product nobody stocks, a combination nothing has, a search about something else — and knowing which is which is the point."
      >
        {zeroResults.length === 0 ? (
          <EmptyState
            title="Nothing came back empty"
            body={`No zero-result searches in the last ${days} days.`}
          />
        ) : (
          <ZeroResultIntelligence
            findings={zeroResults}
            days={days}
            canSuggestAliases={canSuggestAliases}
            basePath={basePath}
          />
        )}
      </Section>

      <Section
        id="most-searched"
        title="Most searched"
        description={`The searches people actually made in the last ${days} days, and what happened next.`}
      >
        {report.top.length === 0 ? (
          <EmptyState
            title="No searches yet"
            body={`Nobody has searched in the last ${days} days. This fills in as shoppers use the search box.`}
          />
        ) : (
          <TableShell>
            <table className="admin-table min-w-[36rem]">
              <thead>
                <tr>
                  <th scope="col">Search</th>
                  <th scope="col" className="text-right">Searches</th>
                  <th scope="col" className="text-right">People</th>
                  <th scope="col" className="text-right">Avg. results</th>
                  <th scope="col" className="text-right">Clicks</th>
                  <th scope="col" className="text-right">Carts</th>
                  <th scope="col" className="text-right">Bought</th>
                </tr>
              </thead>
              <tbody>
                {report.top.map((row) => (
                  <tr key={row.query}>
                    <td>
                      <Link
                        href={`/search?q=${encodeURIComponent(row.query)}`}
                        className="text-blue-600 hover:underline [overflow-wrap:anywhere]"
                      >
                        {row.query}
                      </Link>
                    </td>
                    <td className="text-right tabular-nums">{row.searches}</td>
                    <td className="text-right tabular-nums">{row.visitors}</td>
                    <td className="text-right tabular-nums">{row.averageResults}</td>
                    <td className="text-right tabular-nums">{row.clicks}</td>
                    <td className="text-right tabular-nums">{row.addToCarts}</td>
                    <td className="text-right tabular-nums">{row.purchases}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Section>

      <Section
        id="synonyms"
        title="Synonyms"
        description="Words that should find the same products. A two-way entry works both ways — “earbuds” and “earphones”. A one-way entry only widens the first word — “cellphone” also finds “phone”, but a search for “phone” is left alone. Changes apply to the next search; nothing needs rebuilding."
      >
        <SynonymManager initial={synonyms} prefillTerm={prefillTerm} />
      </Section>

      <Section
        id="index"
        title="Search index"
        description="The database keeps this in step on its own: a product is re-indexed when anything it is searched by changes — its words, its variants, its category, its specifications. Rebuilding is only ever needed after a change to how the index itself is built."
      >
        <MetricGrid>
          <Metric label="Products" value={status.products} />
          <Metric label="Indexed" value={status.indexed} />
          <Metric
            label="Not indexed"
            value={status.missing}
            tone={status.missing > 0 ? "attention" : "plain"}
          />
          <Metric label="Waiting to retry" value={status.queued} />
        </MetricGrid>
        <p className="text-[0.8125rem] text-ink/65">
          {status.lastIndexedAt
            ? `Last change indexed ${formatShortDate(status.lastIndexedAt)}.`
            : "Nothing indexed yet."}
        </p>
        <div>
          <ReindexButton />
        </div>
      </Section>

      <details className="admin-card p-3.5 text-[0.8125rem]">
        <summary className="cursor-pointer font-medium text-ink/80">What is not measured yet</summary>
        <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-ink/65">
          {report.missing.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
