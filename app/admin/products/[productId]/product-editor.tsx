"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * The product editor's main column: a handful of sections on one page, in the
 * order the work is done — basics, media, variants with their prices and
 * stock, product information — with the optional ones folded away.
 *
 * Every panel stays mounted (a folded section is hidden, not removed), because
 * each one saves itself and unmounting would discard an unsaved edit. A jump
 * bar at the top reaches any section; "Fix this" links elsewhere dispatch
 * `product-editor:open` with `{ section, field }` to open it and put the
 * cursor in the field.
 */

export type EditorSection = {
  id: string;
  label: string;
  /** One line under the heading, saying what belongs in the section. */
  summary: string;
  content: ReactNode;
  /** Optional sections fold; required ones always show. */
  collapsible?: boolean;
  defaultOpen?: boolean;
};

export function ProductEditor({
  sections,
  initialSection,
}: {
  sections: EditorSection[];
  initialSection?: string;
}) {
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        sections
          .filter((section) => !section.collapsible || section.defaultOpen || section.id === initialSection)
          .map((section) => section.id),
      ),
  );

  useEffect(() => {
    const go = (id: string, field?: string) => {
      if (!sections.some((section) => section.id === id)) return;
      setOpen((current) => new Set(current).add(id));
      requestAnimationFrame(() => {
        const target = (field && document.getElementById(field)) || document.getElementById(`section-${id}`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (field) document.getElementById(field)?.focus({ preventScroll: true });
      });
    };
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<string | { section: string; field?: string }>).detail;
      if (typeof detail === "string") go(detail);
      else if (detail) go(detail.section, detail.field);
    };
    window.addEventListener("product-editor:open", onOpen);
    if (initialSection) go(initialSection);
    return () => window.removeEventListener("product-editor:open", onOpen);
  }, [sections, initialSection]);

  return (
    <div id="product-editor" className="flex min-w-0 flex-col gap-4">
      <nav aria-label="Product sections" className="flex flex-wrap gap-1.5">
        {sections.map((section, index) => (
          <button
            key={section.id}
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("product-editor:open", { detail: section.id }))}
            className="admin-chip"
          >
            <span className="tabular-nums text-ink/70">{index + 1}.</span> {section.label}
          </button>
        ))}
      </nav>

      {sections.map((section, index) => {
        const isOpen = open.has(section.id);
        return (
          <section
            key={section.id}
            id={`section-${section.id}`}
            aria-labelledby={`heading-${section.id}`}
            data-section-label={section.label}
            // overflow-x: clip keeps a wide table's sideways scroller from
            // widening the whole page on a phone, without making the card a
            // scroll area of its own (menus and dialogs are fixed, unaffected).
            className="admin-card min-w-0 scroll-mt-28 [overflow-x:clip]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id={`heading-${section.id}`} className="admin-h2 text-body">
                  <span className="tabular-nums text-ink/70">{index + 1}.</span> {section.label}
                </h2>
                <p className="mt-0.5 max-w-[70ch] text-[0.8125rem] text-ink/65">{section.summary}</p>
              </div>
              {section.collapsible ? (
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`body-${section.id}`}
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (next.has(section.id)) next.delete(section.id);
                      else next.add(section.id);
                      return next;
                    })
                  }
                  className="shrink-0 rounded-control px-2 py-1 text-meta font-medium text-blue-600 hover:bg-blue-50"
                >
                  {isOpen ? "Hide" : "Show"}
                </button>
              ) : null}
            </div>
            <div id={`body-${section.id}`} hidden={!isOpen} className="mt-4 min-w-0">
              {section.content}
            </div>
          </section>
        );
      })}
    </div>
  );
}
