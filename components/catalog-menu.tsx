"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type CatalogSection = {
  id: string;
  name: string;
  slug: string;
  productCount: number;
  children: { id: string; name: string; slug: string; productCount: number }[];
};

/**
 * The catalogue, as one panel rather than five top-level links.
 *
 * Every shelf and every sub-shelf comes from the category tree staff maintain
 * in the admin — nothing here is a hard-coded list of departments, so a
 * category added this morning is in this menu this afternoon. The counts are
 * live too, which is what stops the menu offering a shelf with nothing on it.
 *
 * It is a button and a panel, not a hover menu: a panel that opens on hover is
 * unusable with a touch screen and hostile with a trackpad. Escape closes it,
 * a click outside closes it, and arriving on a new page closes it.
 *
 * The trigger is the three-line mark at the top left of the header, at every
 * width. The owner asked for that: one symbol for the catalogue, the wordmark
 * beside it, and nothing else until the search field. So this is the only way
 * into the categories from the header, which is why the panel holds the whole
 * tree rather than a shortened list.
 */
export function CatalogMenu({ sections }: { sections: CatalogSection[] }) {
  const pathname = usePathname();
  /**
   * The route the panel was opened on, rather than a plain boolean — a panel
   * left open across a navigation would cover the page just asked for.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpenedAt(null);
      // Focus goes back to what opened the panel, or it is lost to the page.
      buttonRef.current?.focus();
    }

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpenedAt(null);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  if (sections.length === 0) return null;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="catalog-panel"
        onClick={() => setOpenedAt((current) => (current === pathname ? null : pathname))}
        className="-ml-2 inline-flex size-11 items-center justify-center rounded-control text-[color:var(--head-fg)] transition-colors hover:bg-[color:var(--head-ghost)]"
      >
        {/* Three lines that become a cross while the panel is open, so the
            control says what pressing it again will do. */}
        <span aria-hidden="true" className="relative block size-5">
          <span
            className={`absolute left-0 block h-0.5 w-5 rounded-full bg-current transition-transform duration-200 ease-[var(--ease-out-quint)] ${
              open ? "top-1/2 -translate-y-1/2 rotate-45" : "top-1"
            }`}
          />
          <span
            className={`absolute left-0 top-1/2 block h-0.5 w-5 -translate-y-1/2 rounded-full bg-current transition-opacity duration-200 ${
              open ? "opacity-0" : "opacity-100"
            }`}
          />
          <span
            className={`absolute left-0 block h-0.5 w-5 rounded-full bg-current transition-transform duration-200 ease-[var(--ease-out-quint)] ${
              open ? "top-1/2 -translate-y-1/2 -rotate-45" : "bottom-1"
            }`}
          />
        </span>
        <span className="sr-only">
          {open ? "Hide categories" : "Show categories"}
        </span>
      </button>

      {/*
       * Kept in the markup and hidden, rather than mounted on open: the whole
       * catalogue's shelf names are then in the HTML a crawler reads, and the
       * panel opens on the first frame instead of after a render.
       */}
      <div
        id="catalog-panel"
        hidden={!open}
        /* Anchored to the mark it opens from, and never wider than the screen
           it is on: on a phone that is the width of the page minus its
           margins, and the shelves stack into one column. */
        className="animate-rise absolute left-0 top-[calc(100%+0.75rem)] z-40 max-h-[min(34rem,70svh)] w-[min(60rem,calc(100vw-2rem))] overflow-y-auto rounded-card border border-blue-300 bg-paper p-5 text-ink shadow-[var(--shadow-float)] md:p-6"
      >
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((section) => (
            <div key={section.id} className="min-w-0">
              <Link
                href={`/categories/${section.slug}`}
                onClick={() => setOpenedAt(null)}
                className="group flex items-baseline justify-between gap-3 border-b border-blue-200 pb-2"
              >
                <span className="font-display text-h3 text-ink group-hover:text-blue-600">
                  {section.name}
                </span>
                <span className="shrink-0 text-meta tabular-nums text-ink/70">
                  {section.productCount}
                </span>
              </Link>

              {section.children.length > 0 ? (
                <ul className="mt-2 flex flex-col">
                  {section.children.map((child) => (
                    <li key={child.id}>
                      <Link
                        href={`/categories/${child.slug}`}
                        onClick={() => setOpenedAt(null)}
                        className="flex min-h-9 items-center justify-between gap-3 rounded-control px-1.5 text-meta text-ink/70 transition-colors hover:bg-blue-50 hover:text-ink"
                      >
                        <span className="min-w-0 truncate">{child.name}</span>
                        <span className="shrink-0 tabular-nums text-ink/70">
                          {child.productCount}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-blue-200 pt-4">
          <p className="text-meta text-ink/70">
            Every price already carries shipping and customs duty.
          </p>
          <Link
            href="/search"
            onClick={() => setOpenedAt(null)}
            className="link-draw text-meta font-semibold text-blue-600"
          >
            Everything in the catalogue
          </Link>
        </div>
      </div>
    </div>
  );
}
