"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useHeaderTheme } from "./header-theme";

export type HeaderCategory = { id: string; name: string; slug: string };

/**
 * The chrome around the header.
 *
 * It has one more job than it used to. On the home page it is drawn straight
 * over the hero photograph — no bar, no block of brand colour, just the
 * lettering and a veil thin enough to keep it readable — and it takes the
 * opposite treatment to whatever the current slide is: navy over bright
 * imagery, pale over dark. The hero measures each slide and reports it through
 * `header-theme.tsx`; everything here only reacts.
 *
 * Everywhere else, and on the home page once the hero has scrolled away, it is
 * a plain white bar with a brand-blue wordmark. The solid blue rectangle it
 * used to be is gone at the owner's request.
 *
 * The two older behaviours are unchanged: the bar tightens once the page is
 * scrolled, and the category list moves behind a button on a phone where five
 * links across the top would either wrap into three rows or shrink below a
 * usable tap size. The links themselves are rendered on the server and handed
 * in, so the category names are in the HTML a crawler sees whether or not the
 * menu is open.
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
  const { floating, tone } = useHeaderTheme();
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

  /*
   * Over a hero the bar keeps its full height however far the page has been
   * scrolled — the tightening is for a long listing, and here it would fire in
   * the first hundred pixels of the photograph for no reason.
   */
  const tight = scrolled && !floating;

  /*
   * The palette the whole header draws from, as variables rather than branching
   * class names. Every child asks for the same few names and transitions its
   * own colour, so the swap between the two treatments animates across the lot
   * in one movement instead of snapping element by element.
   */
  const floatingDark: CSSProperties = {
    "--head-fg": "#ffffff",
    "--head-muted": "rgb(255 255 255 / 0.78)",
    "--head-ghost": "rgb(255 255 255 / 0.14)",
    "--head-line": "rgb(255 255 255 / 0.28)",
    "--head-field": "rgb(255 255 255 / 0.12)",
    "--veil-dark": "1",
    "--veil-light": "0",
  } as CSSProperties;

  const floatingLight: CSSProperties = {
    "--head-fg": "var(--color-ink)",
    "--head-muted": "rgb(18 35 63 / 0.74)",
    "--head-ghost": "rgb(18 35 63 / 0.07)",
    "--head-line": "rgb(18 35 63 / 0.22)",
    "--head-field": "rgb(255 255 255 / 0.55)",
    "--veil-dark": "0",
    "--veil-light": "1",
  } as CSSProperties;

  const bar: CSSProperties = {
    "--head-fg": "var(--color-ink)",
    "--head-muted": "rgb(18 35 63 / 0.74)",
    "--head-ghost": "rgb(18 35 63 / 0.06)",
    "--head-line": "var(--color-blue-300)",
    "--head-field": "var(--color-paper)",
    "--veil-dark": "0",
    "--veil-light": "0",
  } as CSSProperties;

  const palette = floating ? (tone === "dark" ? floatingDark : floatingLight) : bar;

  return (
    <header
      data-floating={floating ? "true" : "false"}
      data-tone={tone}
      style={palette}
      className={`site-header z-50 text-[color:var(--head-fg)] transition-[background-color,box-shadow,border-color,color] duration-500 ease-[var(--ease-out-quint)] ${
        floating
          ? "fixed inset-x-0 top-0 border-b border-transparent bg-transparent"
          : "sticky top-0 border-b border-blue-300 bg-paper shadow-[var(--shadow-raise)]"
      }`}
    >
      {/*
       * `flex-wrap` so the search field can take a row of its own on a phone.
       * Nested inside the actions group it was squeezed to about forty pixels
       * between the cart icon and the screen edge — a search box you cannot
       * read your own query in.
       */}
      <div
        className={`relative mx-auto flex w-full max-w-[1360px] flex-wrap items-center gap-x-3 gap-y-2 px-4 transition-[padding] duration-300 ease-[var(--ease-out-quint)] md:flex-nowrap md:gap-x-7 md:px-8 ${
          tight ? "py-2" : "py-3.5 md:py-5"
        }`}
      >
        <button
          type="button"
          onClick={() =>
            setOpenedAt((current) => (current === pathname ? null : pathname))
          }
          aria-expanded={menuOpen}
          aria-controls="header-categories"
          className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-[color:var(--head-ghost)] lg:hidden"
        >
          <span aria-hidden="true" className="flex flex-col gap-1">
            <span className="block h-px w-5 bg-current" />
            <span className="block h-px w-5 bg-current" />
            <span className="block h-px w-5 bg-current" />
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
              tight ? "text-h3" : "text-h2"
            }`}
          >
            Manifest
          </span>
          <span
            aria-hidden="true"
            className="hidden text-meta tracking-[0.28em] text-[color:var(--head-muted)] sm:inline"
          >
            BD
          </span>
        </Link>

        {/*
         * The categories sit beside the wordmark from `lg` up, which is what
         * makes the floating header read as one line of navigation rather than
         * a bar with a second bar under it. Below that width they stay in the
         * collapsible row further down, where there is room for a tap target.
         */}
        <nav
          aria-label="Categories"
          className="hidden min-w-0 shrink lg:block"
        >
          <ul className="flex flex-wrap items-center gap-x-6">
            {categories.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/categories/${category.slug}`}
                  className="link-draw whitespace-nowrap text-meta text-[color:var(--head-muted)] transition-colors hover:text-[color:var(--head-fg)]"
                >
                  {category.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/*
         * Both are direct children of the wrapping row, so on a phone the
         * actions stay beside the wordmark and the search drops to a second
         * line at full width. From `md` the row stops wrapping and they sit
         * side by side as before.
         */}
        {search}

        <div className="ml-auto flex shrink-0 items-center md:ml-0">
          {actions}
        </div>
      </div>

      {/*
       * The category row, for every width below `lg`. On a phone it opens under
       * the bar from the button above; on a tablet it is simply the row, and it
       * collapses on scroll to give a long listing the screen back.
       */}
      <nav
        id="header-categories"
        aria-label="Categories"
        className={`overflow-hidden transition-[max-height,opacity] duration-300 ease-[var(--ease-out-quint)] lg:hidden ${
          menuOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
        } ${tight ? "md:max-h-0 md:opacity-0" : "md:max-h-16 md:opacity-100"}`}
      >
        <ul className="mx-auto flex w-full max-w-[1360px] flex-col gap-0 border-t border-[color:var(--head-line)] px-4 pb-2 pt-1 md:flex-row md:flex-wrap md:gap-x-7 md:border-t-0 md:px-8">
          {categories.map((category) => (
            <li key={category.id}>
              <Link
                href={`/categories/${category.slug}`}
                className="flex min-h-11 items-center text-meta text-[color:var(--head-muted)] underline-offset-4 transition-colors hover:text-[color:var(--head-fg)] hover:underline md:min-h-9"
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
