"use client";

import { useRouter } from "next/navigation";
import { IconSearch } from "./icons";
import { useEffect, useId, useRef, useState } from "react";
import { useHeaderTheme } from "./header-theme";

type Suggestion = {
  kind: "product" | "brand" | "category" | "search";
  label: string;
  href: string;
  thumbnailUrl?: string | null;
  hint?: string | null;
};

/** The order the groups appear in, and what each is called. */
const GROUPS: { kind: Suggestion["kind"]; heading: string }[] = [
  { kind: "product", heading: "Products" },
  { kind: "category", heading: "Categories" },
  { kind: "brand", heading: "Brands" },
  { kind: "search", heading: "Suggested searches" },
];

/**
 * The header search, with suggestions.
 *
 * It is a real form first: submitting goes to /search whether or not the
 * suggestion request ever answers, so a slow connection degrades to the search
 * page rather than to nothing. The listbox follows the ARIA combobox pattern —
 * arrow keys move the active option, Enter takes it, Escape closes — and the
 * options are grouped, because "Products", "Categories" and "Suggested
 * searches" are answers to different questions and a flat list of eight makes
 * a shopper work out which is which.
 *
 * The field takes the header's treatment: a white box with a blue border while
 * the header stands on its own bar, and a thin translucent one drawn in the
 * current lettering colour while it floats over the hero photograph.
 */
export function SearchBox({ defaultValue = "" }: { defaultValue?: string }) {
  const router = useRouter();
  const listId = useId();
  const { floating } = useHeaderTheme();
  const [term, setTerm] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  /** Which term the current suggestions answer, so "nothing found" is honest. */
  const [answered, setAnswered] = useState("");
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
      // Set when the request actually goes out, not when the effect runs: a
      // spinner that appears on every keystroke and vanishes 150ms later is
      // noise, and setting state in an effect body is a cascading render.
      setLoading(true);
      try {
        const response = await fetch(
          `/api/search/suggest?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;

        const body = await response.json();
        setSuggestions(body.suggestions ?? []);
        setAnswered(trimmed);
        setActive(-1);
        setOpen(true);
      } catch {
        // An aborted or failed request leaves the form working as a form.
      } finally {
        // An abort is a newer keystroke taking over, and that request sets the
        // flag again immediately — so this never flickers off between letters.
        if (!controller.signal.aborted) setLoading(false);
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

  /*
   * The flat order the keyboard moves through, which has to be the order the
   * options are painted in — otherwise the arrow keys and the eye disagree.
   */
  const ordered = GROUPS.flatMap((group) =>
    suggestions.filter((suggestion) => suggestion.kind === group.kind),
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }

    if (!open || ordered.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % ordered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index <= 0 ? ordered.length - 1 : index - 1));
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      setOpen(false);
      router.push(ordered[active].href);
    }
  }

  const trimmed = term.trim();
  const showEmpty =
    open &&
    !loading &&
    ordered.length === 0 &&
    answered === trimmed &&
    trimmed.length >= 2;
  const showList = open && (ordered.length > 0 || showEmpty);

  return (
    <div
      ref={containerRef}
      className="relative order-last w-full md:order-none md:ml-auto md:w-64 lg:w-56 xl:w-80"
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
              setLoading(false);
              setOpen(false);
            }
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          className={`min-h-11 w-full rounded-control py-2 pl-10 pr-3 text-body transition-[background-color,border-color,color] duration-500 ease-[var(--ease-out-quint)] ${
            floating
              ? "border border-[color:var(--head-line)] bg-[color:var(--head-field)] text-[color:var(--head-fg)] backdrop-blur-md placeholder:text-[color:var(--head-muted)]"
              : "border border-blue-300 bg-paper text-ink placeholder:text-ink/70"
          }`}
        />

        {/* Decorative: the field already has a label and a placeholder, so
            this is an affordance rather than information. */}
        <IconSearch
          size={18}
          className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${
            floating ? "text-[color:var(--head-muted)]" : "text-ink/70"
          }`}
        />

        {/* A quiet mark while a request is out. It replaces nothing and moves
            nothing, so a slow answer never shifts what is under the pointer. */}
        {loading ? (
          <span
            aria-hidden="true"
            className="absolute right-3 top-1/2 size-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-current border-t-transparent opacity-50"
          />
        ) : null}
      </form>

      {showList ? (
        <div
          className="animate-rise absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-card border border-blue-300 bg-paper shadow-[var(--shadow-float)]"
          /* Compact on purpose: a dropdown taller than the fold is a page,
             and a page needs a search results screen, which exists. */
        >
          {/*
           * Divs rather than a list. A listbox's children have to be options
           * or groups of options, and an `li` wrapping a heading is neither —
           * the semantics an unordered list adds here are the ones the
           * combobox pattern then has to fight.
           */}
          <div
            id={listId}
            role="listbox"
            aria-label="Search suggestions"
            className="max-h-[22rem] overflow-y-auto py-1"
          >
            {showEmpty ? (
              <p className="px-3 py-3 text-meta text-ink/70">
                Nothing matched “{trimmed}”. Press Enter to search the whole
                catalogue.
              </p>
            ) : null}

            {GROUPS.map((group) => {
              const inGroup = suggestions.filter(
                (suggestion) => suggestion.kind === group.kind,
              );
              if (inGroup.length === 0) return null;

              return (
                <div key={group.kind} role="group" aria-label={group.heading}>
                  <p
                    aria-hidden="true"
                    className="px-3 pb-1 pt-2 text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-ink/70"
                  >
                    {group.heading}
                  </p>

                  {inGroup.map((suggestion) => {
                    const index = ordered.indexOf(suggestion);
                    return (
                      <a
                        key={`${suggestion.kind}-${suggestion.href}`}
                        id={`${listId}-${index}`}
                        role="option"
                        aria-selected={index === active}
                        href={suggestion.href}
                        onMouseEnter={() => setActive(index)}
                        className={`flex min-h-11 items-center gap-3 px-3 py-1.5 text-body text-ink ${
                          index === active ? "bg-blue-50" : ""
                        }`}
                      >
                        {suggestion.kind === "product" ? (
                          <span className="surface-studio flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-control">
                            {suggestion.thumbnailUrl ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={suggestion.thumbnailUrl}
                                alt=""
                                width={40}
                                height={40}
                                className="size-full object-cover"
                              />
                            ) : null}
                          </span>
                        ) : null}

                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {suggestion.label}
                          </span>
                          {suggestion.hint ? (
                            <span className="block truncate text-meta text-ink/70">
                              {suggestion.hint}
                            </span>
                          ) : null}
                        </span>
                      </a>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
