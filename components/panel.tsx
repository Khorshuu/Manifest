import type { ReactNode } from "react";

/**
 * The boxed surface, defined once.
 *
 * Cart summaries, account panels, admin cards and empty states were each
 * writing their own `border border-blue-300 p-5`, which is why some of them
 * had a shadow and some did not, and why the padding varied between 5, 6 and 8
 * on screens sitting next to each other.
 *
 * Depth carries hierarchy here rather than decoration: `flat` is a plain ruled
 * box, `raised` lifts slightly off the page, and `float` is for the one panel
 * on a screen that is doing the work — a checkout summary, say. Nothing gets
 * `float` twice on one screen.
 */

export type PanelTone = "paper" | "raised" | "ink";
export type PanelDepth = "flat" | "raised" | "float";

const tones: Record<PanelTone, string> = {
  paper: "bg-paper border-blue-300",
  raised: "bg-paper-raised border-blue-300",
  ink: "surface-ink border-ink-deep/40 text-paper",
};

const depths: Record<PanelDepth, string> = {
  flat: "",
  raised: "shadow-[var(--shadow-raise)]",
  float: "shadow-[var(--shadow-lift)]",
};

export function Panel({
  tone = "paper",
  depth = "flat",
  className = "",
  children,
  as: Component = "div",
}: {
  tone?: PanelTone;
  depth?: PanelDepth;
  className?: string;
  children: ReactNode;
  as?: "div" | "section" | "aside" | "li";
}) {
  return (
    <Component
      className={`rounded-card border ${tones[tone]} ${depths[depth]} ${className}`.trim()}
    >
      {children}
    </Component>
  );
}

/**
 * The heading that opens a band inside a page — the brass rule and tracked
 * label the home page uses, at section rather than page level.
 *
 * `PageHeading` is the `h1` version of the same idea. Keeping them as two
 * components rather than one with a `level` prop means neither call site can
 * accidentally emit a second `h1` on a page.
 */
export function SectionHeading({
  eyebrow,
  title,
  summary,
  aside,
  tone = "light",
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  summary?: ReactNode;
  aside?: ReactNode;
  /** `dark` inverts the text for use on `surface-ink`. */
  tone?: "light" | "dark";
  className?: string;
}) {
  const dark = tone === "dark";

  return (
    <div
      className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-4 ${className}`.trim()}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p
            className={`flex items-center gap-3 text-meta uppercase tracking-[0.18em] ${
              dark ? "text-brass" : "text-brass-text"
            }`}
          >
            <span aria-hidden="true" className="h-px w-8 bg-brass" />
            {eyebrow}
          </p>
        ) : null}

        <h2
          className={`mt-2 font-display text-h1 ${dark ? "text-paper" : "text-ink"}`}
        >
          {title}
        </h2>

        {summary ? (
          <div
            className={`mt-2 max-w-[58ch] text-body ${
              dark ? "text-paper/75" : "text-ink/70"
            }`}
          >
            {summary}
          </div>
        ) : null}
      </div>

      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}
