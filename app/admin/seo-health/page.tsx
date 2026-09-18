import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { duplicateReport } from "@/lib/seo/duplicates";
import { seoHealth } from "@/lib/seo/health";
import { imageHealth } from "@/lib/seo/images";
import { linkIntelligence } from "@/lib/seo/links";
import { technicalHealth } from "@/lib/seo/technical";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "SEO health" };

const SEVERITY_LABEL = {
  required: "Needed",
  recommended: "Worth doing",
  optional: "Optional",
} as const;

/**
 * SEO health across the catalogue.
 *
 * Every number here is a count of real listings from a real query, and every
 * row says what to do about it. There is deliberately no site score: a single
 * figure would invite arguing with the number instead of fixing the listings,
 * and no figure this shop can compute predicts a ranking.
 */
export default async function SeoHealthPage() {
  const user = await requireAdminPage("catalog.manage");
  const [health, technical, images, duplicates, links] = await Promise.all([
    seoHealth(user),
    technicalHealth(),
    imageHealth(),
    duplicateReport(),
    linkIntelligence(),
  ]);

  const share = (value: number) =>
    health.indexableListings === 0 ? "—" : `${Math.round((value / health.indexableListings) * 100)}%`;

  const tiles = [
    { label: "Published listings", value: health.publishedListings.toLocaleString("en-GB"), note: "visible to shoppers" },
    { label: "Indexable", value: health.indexableListings.toLocaleString("en-GB"), note: "not hidden from search" },
    { label: "Nothing to fix", value: health.clean.toLocaleString("en-GB"), note: "by the checks below" },
    { label: "Old addresses kept", value: health.redirects.toLocaleString("en-GB"), note: "redirecting to their listing" },
  ];

  const richResult = [
    { label: "With a photograph", value: health.structuredData.withImage },
    { label: "With something to buy", value: health.structuredData.withOffer },
    { label: "With an established brand", value: health.structuredData.withBrand },
    { label: "With a checked identifier", value: health.structuredData.withIdentifier },
  ];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl text-ink">SEO health</h1>
        <p className="max-w-2xl text-sm text-ink/70">
          What is measurably missing across the catalogue. Each row is a query over published listings, with examples to
          start from. Facts about products are fixed in the knowledge base; wording is fixed in the listing editor.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-line bg-surface p-4">
            <p className="text-[0.7rem] uppercase tracking-wide text-ink/55">{tile.label}</p>
            <p className="font-display text-2xl text-ink">{tile.value}</p>
            <p className="text-[0.7rem] text-ink/55">{tile.note}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg text-ink">What a rich result can say</h2>
          <p className="max-w-2xl text-sm text-ink/70">
            Structured data carries only what the shop has established: a price from a live variant, and a brand or an
            identifier only when the knowledge base has verified it or a staff member entered it. Nothing is invented to
            fill a gap.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {richResult.map((row) => (
            <div key={row.label} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-[0.7rem] uppercase tracking-wide text-ink/55">{row.label}</p>
              <p className="font-display text-xl text-ink">
                {row.value.toLocaleString("en-GB")}{" "}
                <span className="text-[0.8rem] font-normal text-ink/55">{share(row.value)}</span>
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg text-ink">What to fix</h2>
        {health.issues.length === 0 ? (
          <EmptyState title="Nothing is failing" body="Every published listing passes these checks." />
        ) : (
          <ul className="flex flex-col gap-3">
            {health.issues.map((issue) => (
              <li key={issue.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <p className="font-medium text-ink">
                      {issue.label}{" "}
                      <span className="text-[0.7rem] uppercase tracking-wide text-ink/50">
                        {SEVERITY_LABEL[issue.severity]}
                      </span>
                    </p>
                    <p className="max-w-2xl text-[0.8rem] text-ink/65">{issue.explanation}</p>
                  </div>
                  <p className="font-display text-xl text-ink">
                    {issue.count.toLocaleString("en-GB")}{" "}
                    <span className="text-[0.75rem] font-normal text-ink/55">{share(issue.count)}</span>
                  </p>
                </div>
                {issue.examples.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-[0.8rem]">
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
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg text-ink">Can the pages be crawled</h2>
          <p className="max-w-2xl text-sm text-ink/70">
            Whether a page can be reached and indexed at all, which sits underneath every question about wording. What
            Google has actually done with them is a separate question, and one this shop cannot answer yet.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: "Indexable listings", value: technical.indexable, note: "crawlable and not hidden" },
            { label: "Hidden from search", value: technical.hiddenFromSearch, note: "public but noindex" },
            { label: "On a hidden shelf", value: technical.onHiddenShelf, note: "reachable only by sitemap" },
            { label: "Shelves hidden", value: technical.hiddenCategories, note: "kept out of the sitemap" },
          ].map((tile) => (
            <div key={tile.label} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-[0.7rem] uppercase tracking-wide text-ink/55">{tile.label}</p>
              <p className="font-display text-xl text-ink">{tile.value.toLocaleString("en-GB")}</p>
              <p className="text-[0.7rem] text-ink/55">{tile.note}</p>
            </div>
          ))}
        </div>
        <ul className="flex flex-col gap-2 text-[0.8rem]">
          {technical.shadowedRedirects.length > 0 ? (
            <li className="rounded-xl border border-line bg-surface p-4">
              <p className="font-medium text-ink">
                {technical.shadowedRedirects.length} old address(es) now belong to a live listing
              </p>
              <p className="text-ink/65">
                The live listing wins and the redirect never runs, so whoever follows the old link lands on the wrong
                product. Give one of them a different address.
              </p>
              <p className="mt-1 font-mono text-ink/55">
                {technical.shadowedRedirects.map((row) => `/products/${row.fromSlug}`).join("  ")}
              </p>
            </li>
          ) : null}
          {technical.deadRedirects.length > 0 ? (
            <li className="rounded-xl border border-line bg-surface p-4">
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
            <li className="rounded-xl border border-line bg-surface p-4">
              <p className="font-medium text-ink">{technical.emptyCategories.length} shelf(s) with nothing published</p>
              <p className="text-ink/65">
                Already left out of the sitemap (D-082). Worth filling or folding into another shelf: a crawler that
                follows the navigation still finds an empty page.
              </p>
              <p className="mt-1 text-ink/55">{technical.emptyCategories.map((row) => row.name).join(", ")}</p>
            </li>
          ) : null}
          {technical.categoriesWithoutMetadata > 0 ? (
            <li className="rounded-xl border border-line bg-surface p-4">
              <p className="font-medium text-ink">
                {technical.categoriesWithoutMetadata} shelf(s) with no SEO title or description of their own
              </p>
              <p className="text-ink/65">
                Every one of them falls back to the same generated sentence with the shelf name swapped in, which is
                duplicate content the shop writes itself. Write a line for each in Categories.
              </p>
            </li>
          ) : null}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg text-ink">Photography</h2>
          <p className="max-w-2xl text-sm text-ink/70">
            {images.photographs.toLocaleString("en-GB")} photograph(s) across {images.listings.toLocaleString("en-GB")}{" "}
            indexable listing(s). Size and weight come from the media registry; a file uploaded outside it has no
            recorded size, which is reported rather than guessed at.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            { label: "Not described", value: images.withoutDescription },
            { label: "Described identically", value: images.duplicateDescription },
            { label: "Too small", value: images.tooSmall },
            { label: "Over 600 KB", value: images.heavy },
            { label: "Size unknown", value: images.unknownSize },
          ].map((tile) => (
            <div key={tile.label} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-[0.7rem] uppercase tracking-wide text-ink/55">{tile.label}</p>
              <p className="font-display text-xl text-ink">{tile.value.toLocaleString("en-GB")}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg text-ink">The same words on more than one page</h2>
          <p className="max-w-2xl text-sm text-ink/70">
            Two pages carrying the same words compete with each other, and a search engine picks one of them without
            asking. Nothing here is rewritten automatically: the words are yours.
          </p>
        </div>
        {duplicates.groups.length === 0 && duplicates.nearDuplicateDescriptions.length === 0 ? (
          <EmptyState title="Nothing is duplicated" body="Every published listing says something of its own." />
        ) : (
          <ul className="flex flex-col gap-3">
            {[...duplicates.groups, ...duplicates.nearDuplicateDescriptions].map((group) => (
              <li key={`${group.field}:${group.value}`} className="rounded-xl border border-line bg-surface p-4">
                <p className="font-medium text-ink">
                  {group.label}{" "}
                  <span className="text-[0.75rem] font-normal text-ink/55">{group.listings.length} listings</span>
                </p>
                <p className="mt-1 text-[0.8rem] text-ink/65">“{group.value}”</p>
                <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-[0.8rem]">
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
          <div className="rounded-xl border border-line bg-surface p-4">
            <p className="font-medium text-ink">{duplicates.thin.length} listing(s) with very little on the page</p>
            <p className="text-[0.8rem] text-ink/65">
              A page with little to read answers fewer questions and has less to be found by. Product facts belong in
              the knowledge base; the words around them belong in the editor.
            </p>
            <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-[0.8rem]">
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
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg text-ink">Links between listings</h2>
          <p className="max-w-2xl text-sm text-ink/70">
            {links.renderedLinks.toLocaleString("en-GB")} link(s) are rendered from accepted relationships. A listing
            nothing points at is reached only through its shelf and the sitemap. Suggestions below are for you to
            decide on — a relationship is a claim about the products, so it is accepted in the knowledge base with its
            evidence, never created here.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {[
            { label: "Nothing links to them", value: links.orphanCount },
            { label: "Links that lead nowhere", value: links.broken.length },
            { label: "Pairs worth a look", value: links.suggestions.length },
          ].map((tile) => (
            <div key={tile.label} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-[0.7rem] uppercase tracking-wide text-ink/55">{tile.label}</p>
              <p className="font-display text-xl text-ink">{tile.value.toLocaleString("en-GB")}</p>
            </div>
          ))}
        </div>
        {links.suggestions.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-4 text-[0.8rem]">
            {links.suggestions.slice(0, 8).map((suggestion) => (
              <li key={`${suggestion.fromProductId}:${suggestion.toProductId}`} className="flex flex-wrap gap-2">
                <Link className="text-blue-600 hover:underline" href={`/admin/products/${suggestion.fromProductId}`}>
                  {suggestion.fromTitle}
                </Link>
                <span className="text-ink/55">and</span>
                <Link className="text-blue-600 hover:underline" href={`/admin/products/${suggestion.toProductId}`}>
                  {suggestion.toTitle}
                </Link>
                <span className="text-ink/55">— {suggestion.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <p className="text-[0.75rem] text-ink/55">
        {health.lockedFields.toLocaleString("en-GB")} field(s) are locked across the catalogue: SEO Pulse will not change
        them, and an apply naming one is refused.
      </p>
    </div>
  );
}
