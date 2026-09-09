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

        <h1 className="mt-2 font-display text-h1 text-ink">{title}</h1>

        {summary ? (
          <div className="mt-2 max-w-[58ch] text-body text-ink/70">
            {summary}
          </div>
        ) : null}
      </div>

      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}
