import { CardSkeleton } from "@/components/card-skeleton";

/** The search results page, in outline, while the query runs. */
export default function SearchLoading() {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <span className="sr-only" role="status">
        Searching
      </span>

      <div aria-hidden="true" className="h-10 w-64 animate-pulse bg-ink/10" />

      <div className="mt-8 grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div
          aria-hidden="true"
          className="h-72 animate-pulse border border-ink/10"
        />
        <CardSkeleton />
      </div>
    </div>
  );
}
