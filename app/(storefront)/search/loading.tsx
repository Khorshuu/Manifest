import { CardSkeleton } from "@/components/card-skeleton";

/** The search results page, in outline, while the query runs. */
export default function SearchLoading() {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-6 md:px-6 md:py-8">
      <span className="sr-only" role="status">
        Searching
      </span>

      <div aria-hidden="true" className="animate-pulse">
        <div className="h-3 w-24 rounded bg-ink/10" />
        <div className="mt-3 h-9 w-72 max-w-full rounded bg-ink/10" />
        <div className="mt-3 h-4 w-56 max-w-full rounded bg-ink/10" />

        <div className="mt-6 flex items-center gap-3 border-y border-ink/10 py-3 lg:border-0 lg:py-0">
          <div className="h-11 flex-1 rounded-control bg-ink/10 sm:w-32 sm:flex-none lg:hidden" />
          <div className="ml-auto h-11 w-44 rounded-control bg-ink/10" />
        </div>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-[264px_minmax(0,1fr)]">
        <div
          aria-hidden="true"
          className="hidden h-96 animate-pulse rounded-card border border-ink/10 lg:block"
        />
        <CardSkeleton />
      </div>
    </div>
  );
}
