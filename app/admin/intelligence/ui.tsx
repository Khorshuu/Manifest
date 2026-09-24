import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The workspace's shared furniture.
 *
 * Seven tabs built out of five screens that each grew their own card border,
 * their own heading size and their own table styling would look like five
 * screens with a tab bar on top. These are the pieces every tab uses, so the
 * workspace reads as one thing: a section, a figure, a table shell, and a
 * count that is also a link to the thing it counts.
 *
 * Nothing here holds state or fetches anything. Each tab's page loads its own
 * data from the system that owns it and renders it through these.
 */

/** The heading every tab starts with: what this tab is, in one line. */
export function TabHeading({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="admin-h1 text-[1.125rem]">{title}</h2>
        <p className="mt-1 max-w-[74ch] text-[0.8125rem] text-ink/65">{children}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** A titled block inside a tab. */
export function Section({
  title,
  description,
  actions,
  children,
  id,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const headingId = `section-${id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section id={id} aria-labelledby={headingId} className="flex min-w-0 scroll-mt-28 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="admin-h2">
            {title}
          </h3>
          {description ? (
            <p className="mt-1 max-w-[74ch] text-[0.8125rem] text-ink/65">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One figure.
 *
 * With an `href` the whole card is a link to the view that lists what it
 * counted — the rule that keeps the overview from being a dead dashboard.
 * Without one it is a plain figure, used where there is no list to go to.
 */
export function Metric({
  label,
  value,
  note,
  href,
  tone = "plain",
}: {
  label: string;
  value: string | number;
  note?: ReactNode;
  href?: string;
  tone?: "plain" | "attention" | "positive";
}) {
  const shown = typeof value === "number" ? value.toLocaleString("en-GB") : value;
  const accent =
    tone === "attention"
      ? "text-brass-text"
      : tone === "positive"
        ? "text-transit-green-text"
        : "text-ink";

  const body = (
    <>
      <span className="admin-kpi-label">{label}</span>
      <span className={`admin-kpi-value mt-1 block ${accent}`}>{shown}</span>
      {note ? <span className="mt-0.5 block text-[0.75rem] text-ink/55">{note}</span> : null}
    </>
  );

  if (!href) {
    return <div className="admin-card flex min-w-0 flex-col p-3.5">{body}</div>;
  }

  return (
    <Link
      href={href}
      className="admin-card flex min-w-0 flex-col p-3.5 transition-colors hover:border-blue-500 hover:bg-blue-50/50"
    >
      {body}
    </Link>
  );
}

/** A grid of figures. Two across on a phone, four on a laptop. */
export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

/**
 * The box a table sits in.
 *
 * `min-w-0` so it does not grow to the width of the table, the scroller so a
 * wide table can be wider than a phone, and `relative` so any visually hidden
 * text inside is clipped by the box rather than widening the page.
 */
export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="admin-card relative min-w-0 max-w-full overflow-x-auto p-0">
      {children}
    </div>
  );
}

/**
 * An expandable block for the raw material — a provider payload, a stored
 * error, an identifier. Available, never first (task section 19).
 */
export function AdvancedDetails({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="admin-card p-3.5 text-[0.8125rem]">
      <summary className="cursor-pointer font-medium text-ink/80">{summary}</summary>
      <div className="mt-3 min-w-0 text-ink/70">{children}</div>
    </details>
  );
}
