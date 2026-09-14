"use client";

import { useId, useState, type ReactNode } from "react";
import { IconChevronDown } from "./icons";

/**
 * One column of the footer: a plain heading and its list on a tablet or a
 * desktop, a row that opens and closes on a phone.
 *
 * On a phone the footer's lists are the part nobody came for, and stacked open
 * they were most of a screen of links under every page. Folded, the footer is
 * three short rows and each list is one tap away. The list stays in the markup
 * either way, so the links are still there for a crawler.
 */
export function FooterSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="border-b border-ink/10 md:border-0">
      {/* The heading is written twice rather than made a button at every
          width: on a desktop a "collapsed" button that opens nothing would
          only confuse a screen reader. */}
      <h2 className="hidden text-meta font-medium uppercase tracking-[0.14em] text-ink md:block">
        {title}
      </h2>
      <h2 className="md:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
          className="flex min-h-12 w-full items-center justify-between gap-3 text-left text-meta font-semibold uppercase tracking-[0.12em] text-ink"
        >
          {title}
          <IconChevronDown
            size={18}
            className={`shrink-0 text-ink/70 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h2>

      <div id={panelId} className={`pb-4 md:block md:pb-0 ${open ? "block" : "hidden"}`}>
        {children}
      </div>
    </div>
  );
}
