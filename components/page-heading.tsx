import type { ReactNode } from "react";

/**
 * The heading every listing page wears.
 *
 * The home page introduces each band with a brass rule, a small tracked label
 * and a display heading. The category and search pages had a bare `h1` instead,
 * which made them read as a different site once the home page was rebuilt.
 * This is that treatment, in one place, so the two cannot drift apart again.
 */
export function PageHeading({
  eyebrow,
  title,
  summary,
  aside,
}: {
  /** The small tracked label above the title. */
  eyebrow: string;
  title: ReactNode;
  /** One sentence under the title. Optional — not every page needs one. */
  summary?: ReactNode;
  /** Controls that belong beside the heading, such as a sort selector. */
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          {eyebrow}
        </p>

        {/* A phone's heading is a label for the page, not a poster: 24px
            leaves the content, not the title, as the first screen. */}
        <h1 className="mt-1.5 font-display text-[1.5rem] leading-tight text-ink sm:mt-2 sm:text-h1">{title}</h1>

        {summary ? (
          <div className="mt-1.5 max-w-[58ch] text-meta text-ink/70 sm:mt-2 sm:text-body">
            {summary}
          </div>
        ) : null}
      </div>

      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}
