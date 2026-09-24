import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import type { SessionUser } from "@/lib/auth/session";
import { duplicateReport } from "@/lib/seo/duplicates";
import { seoHealth } from "@/lib/seo/health";
import { imageHealth } from "@/lib/seo/images";
import { linkIntelligence } from "@/lib/seo/links";
import { technicalHealth } from "@/lib/seo/technical";
import { SEO_SEVERITIES, SEO_SEVERITY_LABEL as SEVERITY_LABEL, type SeoSeverity } from "../filters";
import { Metric, MetricGrid, Section, TabHeading } from "../ui";

/**
 * The SEO Health tab: what is measurably missing across the catalogue.
 *
 * Every number is a count of real listings from a real query, and every row
 * says what to do about it. There is deliberately no site score: a single
 * figure would invite arguing with the number instead of fixing the listings,
 * and no figure this shop can compute predicts a ranking. What Google has
 * actually done with these pages is a different question, answered on the
 * Search Console tab.
 *
 * The audit itself is unchanged — `lib/seo` decides what a finding is and how
 * severe it is. This view groups the findings it returns and lets one severity
 * be picked out, so a link can say "the critical ones" and land on them.
 */

const SEVERITY_EXPLANATION: Record<SeoSeverity, string> = {
  required: "A published listing is missing something a search engine needs.",
  recommended: "Nothing is broken, but the page could say more for itself.",
  optional: "Worth doing when there is time.",
};

export async function SeoHealthPanel({
  user,
  severity,
  basePath,
}: {
  user: SessionUser;
  severity?: SeoSeverity;
  basePath: "/admin/seo-health" | "/admin/intelligence/seo-health";
}) {
  const [health, technical, images, duplicates, links] = await Promise.all([
    seoHealth(user),
    technicalHealth(),
    imageHealth(),
    duplicateReport(),
    linkIntelligence(),
  ]);

  const share = (value: number) =>
    health.indexableListings === 0
      ? "—"
      : `${Math.round((value / health.indexableListings) * 100)}%`;

  const failing = health.issues.filter((issue) => issue.count > 0);
  const countBy = (level: SeoSeverity) =>
    failing.filter((issue) => issue.severity === level).reduce((total, issue) => total + issue.count, 0);

  const shown = severity ? failing.filter((issue) => issue.severity === severity) : failing;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <TabHeading title="SEO Health">
        What is measurably missing across the catalogue. Each finding is a query over published listings, with
        examples to start from. Facts about products are fixed in the knowledge base; wording is fixed in the listing
        editor. There is no overall score, because no figure this shop can compute predicts a ranking.
      </TabHeading>

      <MetricGrid>
        <Metric
          label="Needed"
          value={countBy("required")}
          note="listings failing a required check"
          tone={countBy("required") > 0 ? "attention" : "positive"}
          href={`${basePath}?severity=required`}
        />
        <Metric
          label="Worth doing"
          value={countBy("recommended")}
          note="listings that could say more"
          href={`${basePath}?severity=recommended`}
        />
        <Metric
          label="Optional"
          value={countBy("optional")}
          note="when there is time"
          href={`${basePath}?severity=optional`}
        />
        <Metric
          label="Nothing to fix"
          value={health.clean}
          note="by these checks"
          tone="positive"
        />
      </MetricGrid>

      <Section
        id="findings"
        title={severity ? `Findings — ${SEVERITY_LABEL[severity]}` : "What to fix"}
        description={
          severity ? (
            <>
              {SEVERITY_EXPLANATION[severity]}{" "}
              <Link href={basePath} className="text-blue-600 hover:underline">
                Show every finding
              </Link>
              .
            </>
          ) : (
            `${health.publishedListings.toLocaleString("en-GB")} published listing(s), ${health.indexableListings.toLocaleString("en-GB")} of them indexable. Each finding counts the listings that fail it.`
          )
        }
        actions={
          <nav aria-label="Severity" className="flex flex-wrap gap-1.5">
            <Link href={basePath} aria-current={severity ? undefined : "true"} className="admin-chip">
              All
            </Link>
            {SEO_SEVERITIES.map((level) => (
              <Link
                key={level}
                href={`${basePath}?severity=${level}`}
                aria-current={severity === level ? "true" : undefined}
                className="admin-chip"
              >
                {SEVERITY_LABEL[level]}
              </Link>
            ))}
          </nav>
        }
      >
        {shown.length === 0 ? (
          <EmptyState
            title={severity ? `Nothing is failing at this level` : "Nothing is failing"}
            body={
              severity
                ? `No published listing fails a "${SEVERITY_LABEL[severity].toLowerCase()}" check.`
                : "Every published listing passes these checks."
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {shown.map((issue) => (
              <li key={issue.id} className="admin-card p-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="font-medium text-ink">
                      {issue.label}{" "}
                      <span className="text-[0.7rem] uppercase tracking-wide text-ink/50">
                        {SEVERITY_LABEL[issue.severity]}
                      </span>
                    </p>
                    <p className="max-w-[74ch] text-[0.8125rem] text-ink/65">{issue.explanation}</p>
                  </div>
                  <p className="admin-kpi-value">
                    {issue.count.toLocaleString("en-GB")}{" "}
                    <span className="text-[0.75rem] font-normal text-ink/55">{share(issue.count)}</span>
                  </p>
                </div>
                {issue.examples.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1 border-t border-blue-200 pt-2 text-[0.8125rem]">
                    {issue.examples.map((example) => (
                      <li key={example.id} className="flex flex-wrap items-baseline gap-2">
                        <Link className="text-blue-600 hover:underline" href={`/admin/products/${example.id}`}>
                          {example.title}
                        </Link>
                        {example.detail ? <span className="text-ink/55">{example.detail}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="crawlability"
        title="Can the pages be crawled"
        description="Whether a page can be reached and indexed at all, which sits underneath every question about wording."
      >
        <MetricGrid>
          <Metric label="Indexable listings" value={technical.indexable} note="crawlable and not hidden" />
          <Metric label="Hidden from search" value={technical.hiddenFromSearch} note="public but noindex" />
          <Metric label="On a hidden shelf" value={technical.onHiddenShelf} note="reachable only by sitemap" />
          <Metric label="Shelves hidden" value={technical.hiddenCategories} note="kept out of the sitemap" />
        </MetricGrid>
        <ul className="flex flex-col gap-2 text-[0.8125rem]">
          {technical.shadowedRedirects.length > 0 ? (
            <li className="admin-card p-3.5">
              <p className="font-medium text-ink">
                {technical.shadowedRedirects.length} old address(es) now belong to a live listing
              </p>
              <p className="text-ink/65">
                The live listing wins and the redirect never runs, so whoever follows the old link lands on the wrong
                product. Give one of them a different address.
              </p>
              <p className="mt-1 font-mono text-ink/55 [overflow-wrap:anywhere]">
                {technical.shadowedRedirects.map((row) => `/products/${row.fromSlug}`).join("  ")}
              </p>
            </li>
          ) : null}
          {technical.deadRedirects.length > 0 ? (
            <li className="admin-card p-3.5">
              <p className="font-medium text-ink">
                {technical.deadRedirects.length} old address(es) redirect to a listing shoppers cannot reach
              </p>
              <p className="text-ink/65">
                The redirect still answers, but it arrives at a draft or archived page. Republish it, or point the
                address somewhere useful.
              </p>
            </li>
          ) : null}
          {technical.emptyCategories.length > 0 ? (
            <li className="admin-card p-3.5">
              <p className="font-medium text-ink">
                {technical.emptyCategories.length} shelf(s) with nothing published
              </p>
              <p className="text-ink/65">
                Already left out of the sitemap (D-082). Worth filling or folding into another shelf: a crawler that
                follows the navigation still finds an empty page.
              </p>
              <p className="mt-1 text-ink/55">{technical.emptyCategories.map((row) => row.name).join(", ")}</p>
            </li>
          ) : null}
          {technical.categoriesWithoutMetadata > 0 ? (
            <li className="admin-card p-3.5">
              <p className="font-medium text-ink">
                {technical.categoriesWithoutMetadata} shelf(s) with no SEO title or description of their own
              </p>
              <p className="text-ink/65">
                Every one of them falls back to the same generated sentence with the shelf name swapped in, which is
                duplicate content the shop writes itself. Write a line for each in Categories.
              </p>
            </li>
          ) : null}
          {technical.shadowedRedirects.length === 0 &&
          technical.deadRedirects.length === 0 &&
          technical.emptyCategories.length === 0 &&
          technical.categoriesWithoutMetadata === 0 ? (
            <li>
              <EmptyState
                title="Nothing is in the way"
                body="Every published page can be reached, and every old address leads somewhere live."
              />
            </li>
          ) : null}
        </ul>
      </Section>

      <Section
        id="duplicates"
        title="The same words on more than one page"
        description="Two pages carrying the same words compete with each other, and a search engine picks one of them without asking. Nothing here is rewritten automatically: the words are yours."
      >
        {duplicates.groups.length === 0 && duplicates.nearDuplicateDescriptions.length === 0 ? (
          <EmptyState title="Nothing is duplicated" body="Every published listing says something of its own." />
        ) : (
          <ul className="flex flex-col gap-3">
            {[...duplicates.groups, ...duplicates.nearDuplicateDescriptions].map((group) => (
              <li key={`${group.field}:${group.value}`} className="admin-card p-3.5">
                <p className="font-medium text-ink">
                  {group.label}{" "}
                  <span className="text-[0.75rem] font-normal text-ink/55">{group.listings.length} listings</span>
                </p>
                <p className="mt-1 text-[0.8125rem] text-ink/65">“{group.value}”</p>
                <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-blue-200 pt-2 text-[0.8125rem]">
                  {group.listings.map((listing) => (
                    <li key={listing.id}>
                      <Link className="text-blue-600 hover:underline" href={`/admin/products/${listing.id}`}>
                        {listing.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {duplicates.thin.length > 0 ? (
          <div className="admin-card p-3.5">
            <p className="font-medium text-ink">
              {duplicates.thin.length} listing(s) with very little on the page
            </p>
            <p className="text-[0.8125rem] text-ink/65">
              A page with little to read answers fewer questions and has less to be found by. Product facts belong in
              the knowledge base; the words around them belong in the editor.
            </p>
            <ul className="mt-2 flex flex-col gap-1 border-t border-blue-200 pt-2 text-[0.8125rem]">
              {duplicates.thin.slice(0, 8).map((listing) => (
                <li key={listing.id} className="flex flex-wrap items-baseline gap-2">
                  <Link className="text-blue-600 hover:underline" href={`/admin/products/${listing.id}`}>
                    {listing.title}
                  </Link>
                  <span className="text-ink/55">{listing.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <details className="admin-card p-3.5 text-[0.8125rem]">
        <summary className="cursor-pointer font-medium text-ink/80">
          Rich results, photography and links between listings
        </summary>
        <div className="mt-4 flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <p className="max-w-[74ch] text-ink/65">
              Structured data carries only what the shop has established: a price from a live variant, and a brand or
              an identifier only when the knowledge base has verified it or a staff member entered it. Nothing is
              invented to fill a gap.
            </p>
            <MetricGrid>
              {[
                { label: "With a photograph", value: health.structuredData.withImage },
                { label: "With something to buy", value: health.structuredData.withOffer },
                { label: "With an established brand", value: health.structuredData.withBrand },
                { label: "With a checked identifier", value: health.structuredData.withIdentifier },
              ].map((row) => (
                <Metric key={row.label} label={row.label} value={row.value} note={share(row.value)} />
              ))}
            </MetricGrid>
          </div>

          <div className="flex flex-col gap-3">
            <p className="max-w-[74ch] text-ink/65">
              {images.photographs.toLocaleString("en-GB")} photograph(s) across{" "}
              {images.listings.toLocaleString("en-GB")} indexable listing(s). Size and weight come from the media
              registry, which records every upload. A photograph that arrived some other way has no recorded size, so
              it is counted as unknown rather than guessed at.
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {[
                { label: "Not described", value: images.withoutDescription },
                { label: "Described identically", value: images.duplicateDescription },
                { label: "Too small", value: images.tooSmall },
                { label: "Over 600 KB", value: images.heavy },
                { label: "Size unknown", value: images.unknownSize },
              ].map((row) => (
                <Metric key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <p className="max-w-[74ch] text-ink/65">
              {links.renderedLinks.toLocaleString("en-GB")} link(s) are rendered from accepted relationships. A
              listing nothing points at is reached only through its shelf and the sitemap. A relationship is a claim
              about the products, so it is accepted in the knowledge base with its evidence, never created here.
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {[
                { label: "Nothing links to them", value: links.orphanCount },
                { label: "Links that lead nowhere", value: links.broken.length },
                { label: "Pairs worth a look", value: links.suggestions.length },
              ].map((row) => (
                <Metric key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
            {links.suggestions.length > 0 ? (
              <ul className="flex flex-col gap-1 text-[0.8125rem]">
                {links.suggestions.slice(0, 8).map((suggestion) => (
                  <li key={`${suggestion.fromProductId}:${suggestion.toProductId}`} className="flex flex-wrap gap-2">
                    <Link
                      className="text-blue-600 hover:underline"
                      href={`/admin/products/${suggestion.fromProductId}`}
                    >
                      {suggestion.fromTitle}
                    </Link>
                    <span className="text-ink/55">and</span>
                    <Link
                      className="text-blue-600 hover:underline"
                      href={`/admin/products/${suggestion.toProductId}`}
                    >
                      {suggestion.toTitle}
                    </Link>
                    <span className="text-ink/55">— {suggestion.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <p className="text-ink/55">
            {health.lockedFields.toLocaleString("en-GB")} field(s) are locked across the catalogue: SeoPulse will not
            change them, and an apply naming one is refused. {health.redirects.toLocaleString("en-GB")} old
            address(es) still redirect to their listing.
          </p>
        </div>
      </details>
    </div>
  );
}
