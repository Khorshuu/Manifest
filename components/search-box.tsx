"use client";

import { useRouter } from "next/navigation";
import { IconSearch } from "./icons";
import { useEffect, useId, useRef, useState } from "react";
import { useHeaderTheme } from "./header-theme";

type Suggestion = {
  kind: "product" | "brand" | "category";
  label: string;
  href: string;
};

const KIND_LABELS: Record<Suggestion["kind"], string> = {
  product: "Product",
  brand: "Brand",
  category: "Category",
};

/**
 * The header search, with suggestions.
 *
 * It is a real form first: submitting goes to /search whether or not the
 * suggestion request ever answers, so a slow connection degrades to the search
 * page rather than to nothing. The listbox follows the ARIA combobox pattern —
 * arrow keys move the active option, Enter takes it, Escape closes.
 */
export function SearchBox({ defaultValue = "" }: { defaultValue?: string }) {
  const router = useRouter();
  const listId = useId();
  /*
   * The field belongs to the header, so it takes the header's treatment: a
   * white box with a blue border while the header stands on its own bar, and a
   * thin translucent field drawn in the current lettering colour while the
   * header floats over the hero photograph.
   */
  const { floating } = useHeaderTheme();
  const [term, setTerm] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = term.trim();

    // Clearing is done where the term changes, so this effect only fetches.
    if (trimmed.length < 2) return;

    // Debounced, and cancelled on the next keystroke: a fast typist should not
    // leave a queue of stale requests racing to render.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search/suggest?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;

        const body = await response.json();
        setSuggestions(body.suggestions ?? []);
        setActive(-1);
        setOpen(true);
      } catch {
        // An aborted or failed request leaves the form working as a form.
      }
    }, 150);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) =>
        index <= 0 ? suggestions.length - 1 : index - 1,
      );
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      setOpen(false);
      router.push(suggestions[active].href);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && suggestions.length > 0;

  return (
    <div
      ref={containerRef}
      className="relative order-last w-full md:order-none md:ml-auto md:w-64 lg:w-52 xl:w-72"
    >
      <form action="/search" className="relative">
        <label htmlFor="site-search" className="sr-only">
          Search products
        </label>
        <input
          id="site-search"
          name="q"
          type="search"
          role="combobox"
          autoComplete="off"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            showList && active >= 0 ? `${listId}-${active}` : undefined
          }
          placeholder="Search products"
          value={term}
          onChange={(event) => {
            const next = event.target.value;
            setTerm(next);
            if (next.trim().length < 2) {
              setSuggestions([]);
              setOpen(false);
            }
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          className={`min-h-11 w-full rounded-control py-2 pl-10 pr-3 text-body transition-[background-color,border-color,color] duration-500 ease-[var(--ease-out-quint)] ${
            floating
              ? "border border-[color:var(--head-line)] bg-[color:var(--head-field)] text-[color:var(--head-fg)] placeholder:text-[color:var(--head-muted)]"
              : "border border-blue-500 bg-paper text-ink"
          }`}
        />

        {/* Decorative: the field already has a label and a placeholder, so
            this is an affordance rather than information. */}
        <IconSearch
          size={18}
          className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${
            floating ? "text-[color:var(--head-muted)]" : "text-ink/50"
          }`}
        />
      </form>

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="animate-rise absolute left-0 right-0 top-full z-20 mt-2 max-h-80 overflow-hidden overflow-y-auto rounded-card border border-blue-300 bg-paper shadow-[var(--shadow-float)]"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={`${suggestion.kind}-${suggestion.href}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`border-b border-blue-200 last:border-b-0 ${
                index === active ? "bg-blue-50" : ""
              }`}
            >
              <a
                href={suggestion.href}
                onMouseEnter={() => setActive(index)}
                className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-body text-ink"
              >
                <span className="min-w-0 truncate">{suggestion.label}</span>
                <span className="shrink-0 rounded-card border border-blue-300 px-1.5 py-0.5 text-meta text-ink/70">
                  {KIND_LABELS[suggestion.kind]}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
