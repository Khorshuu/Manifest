"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

export type HeaderCategory = { id: string; name: string; slug: string };

/**
 * The chrome around the header.
 *
 * Two jobs, both of which need the client: the bar tightens once the page has
 * been scrolled, so the catalogue gets the screen back on a long listing; and
 * the category list moves behind a button on a phone, where five links across
 * the top would either wrap into three rows or shrink below a usable tap size.
 *
 * The links themselves are rendered on the server and handed in, so the
 * category names are in the HTML a crawler sees whether or not the menu is
 * open.
 */
export function HeaderShell({
  categories,
  search,
  actions,
}: {
  categories: HeaderCategory[];
  search: ReactNode;
  actions: ReactNode;
}) {
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  /**
   * The route the menu was opened on, rather than a plain boolean.
   *
   * A menu left open across a navigation would cover the page someone just
   * asked for, and deriving it from the current route closes it on arrival
   * without an effect that fires a second render every time.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const menuOpen = openedAt === pathname;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      data-scrolled={scrolled ? "true" : "false"}
      className="sticky top-0 z-40 border-b border-ink-deep/20 bg-blue-600 text-paper shadow-[var(--shadow-raise)]"
    >
      <div
        className={`mx-auto flex w-full max-w-[1280px] items-center gap-3 px-4 transition-[padding] duration-300 ease-[var(--ease-out-quint)] md:gap-6 md:px-6 ${
          scrolled ? "py-2" : "py-3.5"
        }`}
      >
        <button
          type="button"
          onClick={() =>
            setOpenedAt((current) => (current === pathname ? null : pathname))
          }
          aria-expanded={menuOpen}
          aria-controls="header-categories"
          className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-control text-paper transition-colors hover:bg-paper/15 md:hidden"
        >
          <span aria-hidden="true" className="flex flex-col gap-1">
            <span className="block h-0.5 w-5 rounded-full bg-current" />
            <span className="block h-0.5 w-5 rounded-full bg-current" />
            <span className="block h-0.5 w-5 rounded-full bg-current" />
          </span>
          <span className="sr-only">
            {menuOpen ? "Hide categories" : "Show categories"}
          </span>
        </button>

        <Link
          href="/"
          className="flex shrink-0 items-baseline gap-2 font-display tracking-tight"
        >
          <span
            className={`transition-[font-size] duration-300 ease-[var(--ease-out-quint)] ${
              scrolled ? "text-h3" : "text-h2"
            }`}
          >
            Manifest
          </span>
          <span
            aria-hidden="true"
            className="hidden text-meta uppercase tracking-[0.2em] text-paper sm:inline"
          >
            BD
          </span>
        </Link>

        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-3 md:gap-5">
          {search}
          {actions}
        </div>
      </div>

      {/*
       * Desktop: the category row collapses on scroll. Mobile: the same list
       * opens under the bar. One markup, two behaviours, so the names cannot
       * drift apart.
       */}
      <nav
        id="header-categories"
        aria-label="Categories"
        className={`overflow-hidden border-t border-paper/15 transition-[max-height,opacity] duration-300 ease-[var(--ease-out-quint)] md:border-t-0 ${
          menuOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
        } ${
          scrolled
            ? "md:max-h-0 md:opacity-0"
            : "md:max-h-16 md:opacity-100"
        }`}
      >
        <ul className="mx-auto flex w-full max-w-[1280px] flex-col gap-0 px-4 pb-2 md:flex-row md:flex-wrap md:gap-x-6 md:px-6">
          {categories.map((category) => (
            <li key={category.id}>
              <Link
                href={`/categories/${category.slug}`}
                className="flex min-h-11 items-center text-meta text-paper underline-offset-4 transition-colors hover:underline md:min-h-9"
              >
                {category.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
