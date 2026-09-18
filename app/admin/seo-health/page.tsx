import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { seoHealth } from "@/lib/seo/health";

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
  const health = await seoHealth(user);

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

      <p className="text-[0.75rem] text-ink/55">
        {health.lockedFields.toLocaleString("en-GB")} field(s) are locked across the catalogue: SEO Pulse will not change
        them, and an apply naming one is refused.
      </p>
    </div>
  );
}
