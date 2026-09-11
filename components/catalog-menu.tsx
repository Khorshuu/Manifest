"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { IconChevronDown } from "./icons";

export type CatalogSection = {
  id: string;
  name: string;
  slug: string;
  productCount: number;
  children: { id: string; name: string; slug: string; productCount: number }[];
};

/**
 * The catalogue, as a vertical dropdown under the three-line mark.
 *
 * Every shelf comes from the category tree staff maintain — nothing here is a
 * hard-coded list — so a category added this morning is in this menu this
 * afternoon, with a live count. Top-level shelves are rows; a shelf with
 * sub-shelves opens them in place beneath itself, and a long list scrolls
 * inside the panel rather than running off the screen.
 *
 * It is a button and a panel, not a hover menu. Escape closes it, a click
 * outside closes it, and arriving on a new page closes it.
 *
 * It sits above everything else on the page. Opening it closes the phone's
 * filter sheet and raises the header for as long as it is open, so the panel
 * can never open underneath the filters.
 */
export function CatalogMenu({ sections }: { sections: CatalogSection[] }) {
  const pathname = usePathname();
  /**
   * The route the panel was opened on, rather than a plain boolean — a panel
   * left open across a navigation would cover the page just asked for.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const [expanded, setExpanded] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (!open) {
      delete root.dataset.catalogOpen;
      return;
    }

    root.dataset.catalogOpen = "true";
    const drawer = document.getElementById("filter-drawer");
    if (drawer instanceof HTMLInputElement) drawer.checked = false;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpenedAt(null);
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
      delete root.dataset.catalogOpen;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  if (sections.length === 0) return null;

  const close = () => setOpenedAt(null);

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
        {/* Three lines that become a cross while the panel is open. */}
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
        <span className="sr-only">{open ? "Hide categories" : "Show categories"}</span>
      </button>

      {/*
       * Kept in the markup and hidden, rather than mounted on open: every
       * shelf name is then in the HTML a crawler reads, and the panel opens on
       * the first frame instead of after a render.
       */}
      {/*
       * A drawer from the left edge of the screen rather than a box floating
       * over the middle of the hero. The page behind dims evenly under a soft
       * veil, and the drawer itself is near-opaque paper — so it reads the
       * same over a white studio shot, a dark room or a bright colour.
       */}
      {open ? (
        <div
          aria-hidden="true"
          onClick={close}
          className="fixed inset-0 z-[70] bg-ink/35 backdrop-blur-[3px]"
        />
      ) : null}
      <div
        id="catalog-panel"
        role="dialog"
        aria-label="Categories"
        hidden={!open}
        className="animate-rise fixed inset-y-0 left-0 z-[71] flex w-[min(22rem,88vw)] flex-col border-r border-blue-200 bg-paper/95 text-ink shadow-[var(--shadow-float)] backdrop-blur-xl"
      >
        <div className="flex min-h-16 items-center justify-between gap-3 border-b border-blue-200 px-4">
          <p className="font-display text-h3 text-ink">Categories</p>
          <button
            type="button"
            onClick={() => {
              close();
              buttonRef.current?.focus();
            }}
            className="inline-flex size-11 items-center justify-center rounded-control text-ink/70 transition-colors hover:bg-blue-50 hover:text-ink"
          >
            <span aria-hidden="true" className="text-[1.5rem] leading-none">×</span>
            <span className="sr-only">Close categories</span>
          </button>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5">
          {sections.map((section) => {
            const isOpen = expanded === section.id;
            const subId = `catalog-sub-${section.id}`;
            return (
              <li key={section.id}>
                <div className="flex items-center">
                  <Link
                    href={`/categories/${section.slug}`}
                    onClick={close}
                    className="flex min-h-10 min-w-0 flex-1 items-center justify-between gap-3 py-1.5 pl-4 pr-2 text-[0.875rem] font-semibold text-ink transition-colors hover:bg-blue-50 hover:text-blue-600"
                  >
                    <span className="truncate">{section.name}</span>
                    <span className="shrink-0 text-[0.75rem] font-normal tabular-nums text-ink/70">
                      {section.productCount}
                    </span>
                  </Link>
                  {section.children.length > 0 ? (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={subId}
                      onClick={() => setExpanded(isOpen ? null : section.id)}
                      className="mr-1.5 inline-flex size-9 shrink-0 items-center justify-center rounded-control text-ink/70 transition-colors hover:bg-blue-50 hover:text-ink"
                    >
                      <IconChevronDown
                        size={16}
                        className={`transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                      />
                      <span className="sr-only">
                        {isOpen ? `Hide ${section.name} shelves` : `Show ${section.name} shelves`}
                      </span>
                    </button>
                  ) : (
                    <span aria-hidden="true" className="mr-1.5 size-9 shrink-0" />
                  )}
                </div>

                {section.children.length > 0 ? (
                  <ul id={subId} hidden={!isOpen} className="pb-1">
                    {section.children.map((child) => (
                      <li key={child.id}>
                        <Link
                          href={`/categories/${child.slug}`}
                          onClick={close}
                          className="flex min-h-9 items-center justify-between gap-3 py-1 pl-7 pr-12 text-[0.8125rem] text-ink/75 transition-colors hover:bg-blue-50 hover:text-ink"
                        >
                          <span className="truncate">{child.name}</span>
                          <span className="shrink-0 text-[0.75rem] tabular-nums text-ink/70">
                            {child.productCount}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>

        <Link
          href="/search"
          onClick={close}
          className="flex min-h-11 items-center justify-between border-t border-blue-200 px-4 text-[0.8125rem] font-semibold text-blue-600 transition-colors hover:bg-blue-50"
        >
          All products
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </div>
  );
}
