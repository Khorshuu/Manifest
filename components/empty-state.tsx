import type { ReactNode } from "react";
import { LinkButton } from "./button";
import { IconEmptyCrate } from "./icons";

/**
 * What a screen shows when there is nothing on it.
 *
 * Every empty state on the site was a bare bordered rectangle with a sentence
 * in it — technically compliant with "explain what happened and what to do
 * next", and visually indistinguishable from a page that failed to load. This
 * gives the same words a drawn mark, a real hierarchy and a way out, in one
 * component so the cart, the account page, a filtered listing and the admin
 * tables cannot drift apart.
 *
 * The icon is decorative: the title and body carry the whole meaning, so a
 * screen reader is not told about a crate it cannot use.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  secondary,
  className = "",
}: {
  /** Defaults to the empty crate. Pass another when the screen has its own. */
  icon?: ReactNode;
  title: string;
  body: ReactNode;
  action?: { href: string; label: string };
  secondary?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div
      className={`surface-paper flex flex-col items-start gap-4 rounded-card border border-blue-300 px-6 py-10 sm:px-10 sm:py-12 ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className="inline-flex size-12 items-center justify-center rounded-card border border-blue-300 bg-paper text-blue-500 shadow-[var(--shadow-raise)]"
      >
        {icon ?? <IconEmptyCrate size={26} />}
      </span>

      <div>
        <p className="font-display text-h2 text-ink">{title}</p>
        <div className="mt-2 max-w-[52ch] text-body text-ink/70">{body}</div>
      </div>

      {action || secondary ? (
        <div className="mt-1 flex flex-wrap gap-3">
          {action ? (
            <LinkButton href={action.href} variant="primary">
              {action.label}
            </LinkButton>
          ) : null}
          {secondary ? (
            <LinkButton href={secondary.href} variant="secondary">
              {secondary.label}
            </LinkButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
