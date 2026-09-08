/**
 * A grid of product-card outlines, for the moment before a listing arrives.
 *
 * The count is passed in so the skeleton matches the page size that is about
 * to land — a grid that shrinks when the real cards appear is worse than no
 * skeleton at all.
 */
export function CardSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div
      aria-hidden="true"
      className="grid animate-pulse gap-5 sm:grid-cols-2 lg:grid-cols-4"
    >
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-card border border-ink/10 p-3"
        >
          <div className="aspect-square w-full bg-ink/10" />
          <div className="h-3 w-24 bg-ink/10" />
          <div className="h-5 w-3/4 bg-ink/10" />
          <div className="h-6 w-28 bg-ink/10" />
          <div className="h-7 w-32 bg-ink/10" />
        </div>
      ))}
    </div>
  );
}
