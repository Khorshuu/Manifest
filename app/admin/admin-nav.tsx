"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { IconClose } from "@/components/icons";

export type AdminNavItem = { href: string; label: string };

/**
 * The admin chrome.
 *
 * Ten section links across the top wrapped into three rows on a phone, with
 * the account row underneath — CLAUDE.md section 8 asks for admin to stay
 * usable on mobile and this was the clearest place it was not. The links move
 * behind a button below `md`, exactly as the storefront header does, so the
 * two halves of the product behave the same way.
 *
 * The current section is marked rather than left to be inferred from the page
 * title, which is the `nav-state-active` rule and the thing that makes a
 * ten-item nav navigable at all.
 */
export function AdminNav({
  items,
  identity,
  signOut,
}: {
  items: readonly AdminNavItem[];
  identity: string;
  signOut: ReactNode;
}) {
  const pathname = usePathname();
  /**
   * The route the menu was opened on, rather than a plain boolean: a menu left
   * open across a navigation would cover the page just asked for, and deriving
   * it from the current route closes it on arrival without an effect that
   * fires a second render every time.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;

  const isCurrent = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-40 bg-blue-600 text-paper shadow-[var(--shadow-raise)]">
      <div className="mx-auto flex w-full max-w-[1280px] items-center gap-3 px-4 py-2.5 md:px-6">
        <Link
          href="/admin"
          className="flex shrink-0 items-baseline gap-2 font-display tracking-tight"
        >
          <span className="text-h3">Manifest</span>
          <span
            aria-hidden="true"
            className="text-meta uppercase tracking-[0.2em] text-paper"
          >
            Admin
          </span>
        </Link>

        <div className="ml-auto flex shrink-0 items-center gap-2 md:gap-3">
          <span className="hidden text-meta text-paper sm:inline">
            {identity}
          </span>
          {signOut}

          <button
            type="button"
            onClick={() =>
              setOpenedAt((current) => (current === pathname ? null : pathname))
            }
            aria-expanded={open}
            aria-controls="admin-sections"
            className="-mr-2 inline-flex size-11 items-center justify-center rounded-control text-paper transition-colors hover:bg-paper/15 md:hidden"
          >
            {open ? (
              <IconClose size={20} />
            ) : (
              <span aria-hidden="true" className="flex flex-col gap-1">
                <span className="block h-0.5 w-5 rounded-full bg-current" />
                <span className="block h-0.5 w-5 rounded-full bg-current" />
                <span className="block h-0.5 w-5 rounded-full bg-current" />
              </span>
            )}
            <span className="sr-only">
              {open ? "Hide admin sections" : "Show admin sections"}
            </span>
          </button>
        </div>
      </div>

      {/*
       * Desktop: the sections get a row of their own.
       *
       * Ten links, a wordmark, an email address and a sign-out button do not
       * fit across 1280px, so sharing one row meant the nav wrapped underneath
       * itself and the current section was impossible to find. A second row is
       * the honest answer.
       */}
      <nav
        aria-label="Admin sections"
        className="hidden border-t border-paper/15 md:block"
      >
        <ul className="mx-auto flex w-full max-w-[1280px] flex-wrap gap-x-1 px-4 pb-1.5 md:px-6">
          {items.map((item) => {
            const current = isCurrent(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={`relative inline-flex min-h-9 items-center rounded-control px-2.5 text-meta text-paper transition-colors ${
                    current ? "font-medium" : "hover:bg-paper/10"
                  }`}
                >
                  {item.label}
                  {/* An underline on the current section rather than a filled
                      pill: the bar already carries a lot of blue. */}
                  {current ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-2 -bottom-0.5 h-0.5 rounded-full bg-brass"
                    />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Mobile: the same list, behind the button. */}
      <div
        id="admin-sections"
        className={`overflow-hidden border-t border-paper/15 transition-[max-height,opacity] duration-300 ease-[var(--ease-out-quint)] md:hidden ${
          open ? "max-h-[36rem] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <nav aria-label="Admin sections">
          <ul className="mx-auto flex w-full max-w-[1280px] flex-col px-4 py-2">
            {items.map((item) => {
              const current = isCurrent(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? "page" : undefined}
                    className={`flex min-h-11 items-center rounded-control px-2 text-body text-paper transition-colors ${
                      current ? "bg-paper/20 font-medium" : "hover:bg-paper/10"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-3 border-t border-paper/15 px-4 py-3 sm:hidden">
          <span className="text-meta text-paper">{identity}</span>
        </div>
      </div>
    </header>
  );
}
