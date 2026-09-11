import Link from "next/link";
import { LinkButton } from "./button";
import { IconSearch } from "./icons";

/**
 * A search that found nothing, made useful.
 *
 * It says what was searched, offers a correction when there is a confident
 * one, gives the four pieces of advice that actually help, and lists the parts
 * of the search that do find something on their own — "headphones (3)" from
 * "purple studio headphones". It never fills the space with unrelated
 * products: a page of things nobody asked for reads as the shop not listening.
 */
export function NoResults({
  query,
  suggestion,
  related,
  filtered,
  clearHref,
}: {
  query: string;
  suggestion: string | null;
  related: { query: string; count: number }[];
  /** Filters are on — removing them is then the first thing to try. */
  filtered: boolean;
  clearHref: string;
}) {
  const searchHref = (text: string) => `/search?q=${encodeURIComponent(text)}`;

  return (
    <div className="surface-paper flex flex-col gap-5 rounded-card border border-blue-300 px-6 py-8 sm:px-10 sm:py-10">
      <span
        aria-hidden="true"
        className="inline-flex size-12 items-center justify-center rounded-card border border-blue-300 bg-paper text-blue-500 shadow-[var(--shadow-raise)]"
      >
        <IconSearch size={24} />
      </span>

      <div>
        <p className="font-display text-h2 text-ink [overflow-wrap:anywhere]">
          Nothing matched “{query}”
        </p>
        {suggestion ? (
          <p className="mt-2 text-body text-ink">
            Did you mean{" "}
            <Link
              href={searchHref(suggestion)}
              className="font-semibold text-blue-600 underline underline-offset-4"
            >
              {suggestion}
            </Link>
            ?
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-meta font-semibold text-ink">Try</p>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-body text-ink/80">
          {filtered ? <li>Removing a filter or two</li> : null}
          <li>Checking the spelling</li>
          <li>Using fewer words, or more general ones</li>
          <li>Searching for a kind of product — “headphones” rather than a model name</li>
        </ul>
      </div>

      {related.length > 0 ? (
        <div>
          <p className="text-meta font-semibold text-ink">Related searches</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {related.map((entry) => (
              <li key={entry.query}>
                <Link
                  href={searchHref(entry.query)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-control border border-blue-300 bg-paper px-3 text-meta font-medium text-blue-600 transition-colors hover:border-blue-500 hover:bg-blue-50"
                >
                  {entry.query}
                  <span className="tabular-nums text-ink/70">{entry.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {filtered ? (
          <LinkButton href={clearHref} variant="primary">
            Clear filters
          </LinkButton>
        ) : null}
        <LinkButton href="/search" variant={filtered ? "secondary" : "primary"}>
          See everything we have
        </LinkButton>
      </div>
    </div>
  );
}
