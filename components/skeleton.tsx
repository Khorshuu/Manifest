/**
 * The shape of content that has not arrived yet.
 *
 * A skeleton is only worth showing if it is the shape of the thing that
 * replaces it — a grid that changes size when the real content lands is worse
 * than no skeleton at all — so these mirror the real layouts rather than being
 * generic grey bars.
 *
 * All of it is `aria-hidden`: a screen reader is told the route is loading by
 * the framework, and reading out a dozen empty boxes would be noise.
 */

export function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`rounded-card bg-ink/10 ${className}`.trim()} />;
}

/** The heading every page opens with: eyebrow, title, one line of summary. */
export function SkeletonHeading() {
  return (
    <div className="flex flex-col gap-3">
      <SkeletonBar className="h-3 w-28" />
      <SkeletonBar className="h-9 w-64" />
      <SkeletonBar className="h-4 w-full max-w-[46ch]" />
    </div>
  );
}

/** A stack of rows inside a panel — orders, items, audit entries. */
export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-6 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <SkeletonBar className="h-5 w-40" />
            <SkeletonBar className="h-3 w-28" />
          </div>
          <SkeletonBar className="h-6 w-24" />
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden="true" className="animate-pulse">
      {children}
    </div>
  );
}
