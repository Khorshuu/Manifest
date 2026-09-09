import Link from "next/link";
import { IconClose } from "./icons";
import type { FilterChip } from "@/lib/catalog";

/**
 * What is currently narrowing the listing, and how to stop it.
 *
 * Each chip removes its own filter and nothing else, and "Clear all" returns
 * to the same listing with none. Both are ordinary links: filtering is a
 * navigation here, so undoing it is one too, and the back button works.
 *
 * The count sits with them rather than in the heading, because "3 filters, 12
 * products" is one sentence a shopper reads in one glance.
 */
export function ActiveFilters({
  chips,
  clearHref,
  total,
}: {
  chips: FilterChip[];
  /** The listing with every filter removed. */
  clearHref: string;
  total: number;
}) {
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-meta font-semibold text-ink">
        {total} {total === 1 ? "product" : "products"}
      </p>

      <span aria-hidden="true" className="h-4 w-px bg-ink/15" />

      <ul className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <li key={chip.key}>
            <Link
              href={chip.href}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-control border border-blue-300 bg-blue-50 px-2.5 text-meta font-medium text-ink transition-colors hover:border-blue-500 hover:bg-blue-200/60"
            >
              {chip.label}
              <IconClose size={14} className="shrink-0 opacity-60" />
              <span className="sr-only">— remove this filter</span>
            </Link>
          </li>
        ))}
      </ul>

      <Link
        href={clearHref}
        className="link-draw text-meta font-semibold text-blue-600"
      >
        Clear all
      </Link>
    </div>
  );
}
