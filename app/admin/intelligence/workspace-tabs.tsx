"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { IntelligenceTab } from "./tabs";

/**
 * The workspace's tab bar.
 *
 * Real links to real routes, so the selected tab is in the address bar, a
 * refresh keeps it, the browser's back and forward buttons work, and a deep
 * link with a filter on it opens the right tab already filtered. Next's
 * client router handles the navigation, so moving between tabs does not
 * reload the page.
 *
 * On a phone the row scrolls sideways inside its own box — it is pulled out
 * to the page gutter and padded back in, so the bar reaches the edge of the
 * screen without the page itself ever scrolling sideways.
 */
export function WorkspaceTabs({ tabs }: { tabs: readonly IntelligenceTab[] }) {
  const pathname = usePathname();

  const isCurrent = (href: string) =>
    href === "/admin/intelligence" ? pathname === href : pathname.startsWith(href);

  return (
    <nav
      aria-label="Intelligence sections"
      className="-mx-4 min-w-0 overflow-x-auto px-4 md:-mx-6 md:px-6 [scrollbar-width:thin]"
    >
      <ul className="flex w-max gap-1.5 border-b border-blue-200 pb-px">
        {tabs.map((tab) => {
          const current = isCurrent(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={current ? "page" : undefined}
                className={`relative inline-flex min-h-11 items-center whitespace-nowrap rounded-t-control px-3 text-[0.8125rem] font-medium transition-colors ${
                  current
                    ? "text-blue-600"
                    : "text-ink/70 hover:bg-blue-50 hover:text-ink"
                }`}
              >
                {tab.label}
                {current ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-blue-600"
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
