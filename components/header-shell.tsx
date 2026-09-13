"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
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
   *
   * They are classes rather than inline variables so each is a literal the
   * stylesheet can see. The header floats over the hero at every width, a
   * phone included — the owner wants it transparent there, as on the web.
   */
  const bar =
    "[--head-fg:var(--color-ink)] [--head-muted:rgb(18_35_63/0.74)] [--head-ghost:rgb(18_35_63/0.06)] [--head-line:var(--color-blue-300)] [--head-field:var(--color-paper)] [--veil-dark:0] [--veil-light:0]";

  const floatingDark =
    "[--head-fg:#ffffff] [--head-muted:rgb(255_255_255/0.78)] [--head-ghost:rgb(255_255_255/0.14)] [--head-line:rgb(255_255_255/0.55)] [--head-field:rgb(255_255_255/0.08)] [--veil-dark:1] [--veil-light:0]";

  const floatingLight =
    "[--head-fg:var(--color-ink)] [--head-muted:rgb(18_35_63/0.74)] [--head-ghost:rgb(18_35_63/0.07)] [--head-line:rgb(18_35_63/0.3)] [--head-field:rgb(255_255_255/0.28)] [--veil-dark:0] [--veil-light:1]";

  const palette = floating ? (tone === "dark" ? floatingDark : floatingLight) : bar;

  return (
    <header
      data-floating={floating ? "true" : "false"}
      data-tone={tone}
      className={`site-header ${palette} z-50 text-[color:var(--head-fg)] transition-[background-color,box-shadow,border-color,color] duration-500 ease-[var(--ease-out-quint)] ${
        floating
          ? "fixed inset-x-0 top-0 border-b border-transparent bg-transparent"
          : "sticky top-0 border-b border-blue-300 bg-paper shadow-[var(--shadow-raise)]"
      }`}
    >
      {/*
       * One row at every width. On a phone the search is an icon that opens a
       * full-screen search (see SearchBox), so nothing has to wrap onto a
       * second line — which is what lets the header float over a landscape
       * hero there without covering half of it.
       */}
      <div
        className={`relative mx-auto flex w-full max-w-[1360px] items-center gap-x-1.5 px-4 transition-[padding] duration-300 ease-[var(--ease-out-quint)] sm:gap-x-3 md:gap-x-7 md:px-8 ${
          tight ? "py-1.5 md:py-2" : "py-2 md:py-5"
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
              tight ? "text-h3" : "text-h3 sm:text-h2"
            }`}
          >
            Manifest
          </span>
        </Link>

        {/* The search: an icon on a phone, the field itself from `md`. It
            carries its own `ml-auto`, which pushes it and the actions to the
            right-hand end of the row. */}
        {search}

        <div className="flex shrink-0 items-center">
          {actions}
        </div>
      </div>

    </header>
  );
}
