"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CatalogMenu, type CatalogSection } from "./catalog-menu";
import { useHeaderTheme } from "./header-theme";

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
 * The row itself is what the owner asked for and nothing more: the three-line
 * catalogue mark at the top left, the wordmark beside it, nothing at all until
 * the search field, then the account and cart. The shelf links that used to sit
 * between the wordmark and the search — and the collapsible row of them under
 * the bar on a phone — are gone; every category now lives in the panel behind
 * that one mark, at every width. Those links are still rendered on the server
 * and hidden rather than mounted on open, so the category names are in the HTML
 * a crawler reads whether or not anyone opens the panel.
 *
 * The older behaviour that stays: the bar tightens once the page is scrolled.
 */
export function HeaderShell({
  sections,
  search,
  actions,
}: {
  /** The catalogue, two levels deep, with live counts. */
  sections: CatalogSection[];
  search: ReactNode;
  actions: ReactNode;
}) {
  const [scrolled, setScrolled] = useState(false);
  const { floating, tone } = useHeaderTheme();

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
    "--head-line": "rgb(255 255 255 / 0.55)",
    "--head-field": "rgb(255 255 255 / 0.08)",
    "--veil-dark": "1",
    "--veil-light": "0",
  } as CSSProperties;

  const floatingLight: CSSProperties = {
    "--head-fg": "var(--color-ink)",
    "--head-muted": "rgb(18 35 63 / 0.74)",
    "--head-ghost": "rgb(18 35 63 / 0.07)",
    "--head-line": "rgb(18 35 63 / 0.3)",
    "--head-field": "rgb(255 255 255 / 0.28)",
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
        {/* The catalogue: one mark at the top left, at every width, opening a
            panel that holds every shelf and sub-shelf from the tree staff
            maintain. */}
        <CatalogMenu sections={sections} />

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
        </Link>

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

    </header>
  );
}
