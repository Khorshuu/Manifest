import Link from "next/link";
import { IconArrowLeft, IconArrowRight } from "./icons";

/**
 * Numbered pages for a listing, with the current one marked for sight and
 * for a screen reader (`aria-current`). Every page is an ordinary link that
 * keeps the filters and the sort, so a page can be shared and the back button
 * walks back through them.
 *
 * On a phone the numbers give way to "Page 2 of 7" between the two arrows:
 * seven small targets in a row is a mis-tap waiting to happen.
 */

type Entry = number | "gap";

/** 1 … 4 5 6 … 12 — the ends, and the current page's neighbours. */
export function pageWindow(page: number, pageCount: number): Entry[] {
  const wanted = new Set([1, pageCount, page - 1, page, page + 1]);
  const pages = [...wanted]
    .filter((entry) => entry >= 1 && entry <= pageCount)
    .sort((a, b) => a - b);

  const entries: Entry[] = [];
  pages.forEach((entry, index) => {
    if (index > 0 && entry - pages[index - 1] > 1) entries.push("gap");
    entries.push(entry);
  });
  return entries;
}

const control =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-blue-300 bg-paper px-4 text-body font-medium text-blue-600 transition-[background-color,border-color,box-shadow] duration-150 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]";

export function Pagination({
  page,
  pageCount,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label="Pagination"
      className="mt-10 flex flex-wrap items-center justify-center gap-2"
    >
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} rel="prev" className={control}>
          <IconArrowLeft size={16} />
          Previous
        </Link>
      ) : null}

      <ol className="hidden items-center gap-1 sm:flex">
        {pageWindow(page, pageCount).map((entry, index) =>
          entry === "gap" ? (
            <li
              key={`gap-${index}`}
              aria-hidden="true"
              className="px-1 text-meta text-ink/70"
            >
              …
            </li>
          ) : (
            <li key={entry}>
              <Link
                href={hrefFor(entry)}
                aria-current={entry === page ? "page" : undefined}
                aria-label={`Page ${entry}`}
                className={`inline-flex size-11 items-center justify-center rounded-control text-body tabular-nums transition-colors ${
                  entry === page
                    ? "bg-ink font-semibold text-paper"
                    : "text-ink hover:bg-blue-50"
                }`}
              >
                {entry}
              </Link>
            </li>
          ),
        )}
      </ol>

      <span className="inline-flex min-h-11 items-center px-2 text-meta text-ink/70 sm:hidden">
        Page {page} of {pageCount}
      </span>

      {page < pageCount ? (
        <Link href={hrefFor(page + 1)} rel="next" className={control}>
          Next
          <IconArrowRight size={16} />
        </Link>
      ) : null}
    </nav>
  );
}
