"use client";

import { useRouter, useSearchParams } from "next/navigation";

const options = [
  { value: "relevance", label: "Most relevant" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "rating", label: "Best rated" },
] as const;

export function SortSelect({ current }: { current: string }) {
  const router = useRouter();
  const params = useSearchParams();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="sort" className="text-meta text-ink/70">
        Sort
      </label>
      <select
        id="sort"
        value={current}
        onChange={(event) => {
          const next = new URLSearchParams(params.toString());
          next.set("sort", event.target.value);
          next.delete("page");
          router.push(`?${next.toString()}`);
        }}
        className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
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
