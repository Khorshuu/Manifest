"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  const pathname = usePathname();

  /*
   * On a product page below `lg` the photograph starts at the very top of the
   * screen with no header over it (D-048). The header waits out of sight and
   * slides down once the shopper has scrolled a good part of the photograph
   * away, and slides back up when they return to it. Anything inside it
   * taking keyboard focus brings it back regardless, so it is never a trap.
   */
  const onProduct = pathname.startsWith("/products/");
  const [pastPhoto, setPastPhoto] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 24);
      if (!onProduct) return;
      const photo = document.querySelector("[data-product-photo]");
      if (!photo) {
        setPastPhoto(true);
        return;
      }
      const rect = photo.getBoundingClientRect();
      // Once about two fifths of the photograph has scrolled off the top.
      setPastPhoto(rect.bottom < rect.height * 0.6);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    /*
     * A product page that is slow to render arrives as its loading state
     * first, with no photograph in it, and the check above shows the header.
     * Without a scroll nothing would check again, so the header stayed over
     * the photograph once it arrived. Watch for the photograph instead, and
     * stop watching as soon as it is there.
     */
    let observer: MutationObserver | null = null;
    if (onProduct && !document.querySelector("[data-product-photo]")) {
      observer = new MutationObserver(() => {
        if (!document.querySelector("[data-product-photo]")) return;
        observer?.disconnect();
        observer = null;
        onScroll();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [onProduct, pathname]);

  const tucked = onProduct && !pastPhoto && !focused;

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
      data-tucked={tucked ? "true" : undefined}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setFocused(false);
      }}
      /*
       * Tucked, it is moved up out of view and faded, rather than hidden: a
       * screen reader still finds the navigation. No translate at all while
       * it is showing — any transform would become the containing block for
       * the fixed category drawer and search inside it.
       */
      className={`site-header ${palette} z-50 text-[color:var(--head-fg)] transition-[background-color,box-shadow,border-color,color,translate,opacity] duration-500 ease-[var(--ease-out-quint)] ${
        floating
          ? "fixed inset-x-0 top-0 border-b border-transparent bg-transparent"
          : "sticky top-0 border-b border-blue-300 bg-paper shadow-[var(--shadow-raise)]"
      } ${onProduct ? "max-lg:fixed max-lg:inset-x-0" : ""} ${
        tucked
          ? "max-lg:pointer-events-none max-lg:-translate-y-full max-lg:opacity-0 max-lg:shadow-none"
          : ""
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
