"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export type SortOption = { value: string; label: string };

/**
 * The sort control. Only the orders the catalogue can honestly offer are
 * passed in — "Best selling" appears once something has sold (see
 * `sortSignals`) — and changing it keeps every filter and drops the page
 * number, since page three of a re-sorted listing is a different page three.
 */
export function SortSelect({
  current,
  options,
}: {
  current: string;
  options: readonly SortOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor="sort" className="shrink-0 text-meta text-ink/70">
        Sort
      </label>
      <select
        id="sort"
        value={current}
        aria-busy={pending}
        onChange={(event) => {
          const next = new URLSearchParams(params.toString());
          next.set("sort", event.target.value);
          next.delete("page");
          startTransition(() => {
            router.push(`?${next.toString()}`, { scroll: false });
          });
        }}
        className={`min-h-10 min-w-0 rounded-control border border-blue-300 bg-paper px-2.5 text-meta font-medium text-ink transition-opacity ${
          pending ? "opacity-60" : ""
        }`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
