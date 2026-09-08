import { CardSkeleton } from "@/components/card-skeleton";

/** The category listing, in outline, while its products are fetched. */
export default function CategoryLoading() {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <span className="sr-only" role="status">
        Loading this category
      </span>

      <div aria-hidden="true" className="animate-pulse">
        <div className="h-4 w-48 bg-ink/10" />
        <div className="mt-6 h-10 w-72 bg-ink/10" />
      </div>

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
