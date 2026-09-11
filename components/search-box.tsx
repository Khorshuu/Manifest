"use client";

import Form from "next/form";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { formatBdt } from "@/lib/money";
import { looksPersonal } from "@/lib/search/normalize";
import type { Suggestion } from "@/lib/search/suggest";
import { IconArrowRight, IconClock, IconClose, IconSearch } from "./icons";
import { useHeaderTheme } from "./header-theme";

/**
 * The header search.
 *
 * It is a real form first: submitting goes to /search whether or not a
 * suggestion ever arrives, so a slow connection degrades to the results page
 * rather than to nothing, and with JavaScript off it is still a working
 * search box.
 *
 * On top of that, the ARIA combobox pattern: focus stays in the field, the
 * arrow keys move through the suggestions, Enter takes the highlighted one,
 * Escape closes the list and a second Escape clears the field. Before anything
 * is typed it offers the shopper's recent searches — kept on their account
 * when signed in, in this browser otherwise — and searches enough other people
 * ran that found something. Once two characters are typed it offers searches
 * completed from the catalogue, a few products with their price, the shelves
 * they sit on, and brands.
 *
 * On a phone the field becomes a full-screen search when it is focused: the
 * list gets the whole height instead of a sliver under the header, the targets
 * are larger, and "Cancel" is where a thumb expects it.
 */

const RECENT_KEY = "manifest.recent-searches";
const RECENT_LIMIT = 8;

type OptionKind = Suggestion["kind"] | "recent" | "popular" | "trending";

type Option = {
  key: string;
  kind: OptionKind;
  label: string;
  href: string;
  suggestion?: Suggestion;
};

type Section = { key: string; heading: string; options: Option[] };

type Answer = {
  term: string;
  suggestions: Suggestion[];
  correctedQuery: string | null;
};

const searchHref = (query: string) =>
  `/search?q=${encodeURIComponent(query)}`;

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
  } catch {
    // Private browsing or a full quota: recent searches are a convenience.
  }
}

function withRecent(list: string[], query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return list;
  return [
    trimmed,
    ...list.filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase()),
  ].slice(0, RECENT_LIMIT);
}

/** The query an option stands for, when choosing it is a search. */
function queryOf(option: Option): string | null {
  switch (option.kind) {
    case "search":
    case "recent":
    case "popular":
    case "trending":
    case "brand":
      return option.label;
    case "category":
      return option.suggestion?.scope ?? null;
    default:
      return null;
  }
}

/** Marks the part of a completion the shopper has not typed yet. */
function Completion({ label, typed }: { label: string; typed: string }) {
  const prefix = typed.trim().toLowerCase();
  if (prefix && label.toLowerCase().startsWith(prefix) && label.length > prefix.length) {
    return (
      <>
        <span>{label.slice(0, prefix.length)}</span>
        <strong className="font-semibold">{label.slice(prefix.length)}</strong>
      </>
    );
  }
  return <>{label}</>;
}

const fieldBar =
  "border border-blue-300 bg-paper text-ink placeholder:text-ink/70";
/*
 * Over the hero the field is glass rather than a box: a thin pale rule, a
 * faint tint and a blur of the photograph behind it, at the same size as the
 * solid field so nothing in the header moves when the treatment changes.
 */
const fieldFloating =
  "border border-[color:var(--head-line)] bg-[color:var(--head-field)] text-[color:var(--head-fg)] backdrop-blur-md backdrop-saturate-150 placeholder:text-[color:var(--head-muted)]";

function SubmitButton({ floating = false }: { floating?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-label="Search"
      className={
        floating
          ? "inline-flex size-9 shrink-0 items-center justify-center rounded-[8px] text-[color:var(--head-fg)] transition-[background-color,transform] duration-150 hover:bg-[color:var(--head-ghost)] active:scale-95"
          : "surface-brass inline-flex size-9 shrink-0 items-center justify-center rounded-[8px] text-ink shadow-[var(--shadow-raise)] transition-[filter,transform] duration-150 hover:brightness-[1.05] active:scale-95"
      }
    >
      {pending ? (
        <span
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        <IconSearch size={18} />
      )}
    </button>
  );
}

export function SearchBox({ signedIn = false }: { signedIn?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const listId = useId();
  const hintId = useId();
  const recentHintId = useId();
  const { floating } = useHeaderTheme();

  // The field shows the search being looked at, and follows it: arriving on
  // "/search?q=kettle" by any route — a suggestion, a "Did you mean", the back
  // button — puts "kettle" in the box.
  const urlQuery = pathname === "/search" ? (params.get("q") ?? "") : "";
  const [term, setTerm] = useState(urlQuery);
  const [syncedQuery, setSyncedQuery] = useState(urlQuery);
  if (syncedQuery !== urlQuery) {
    setSyncedQuery(urlQuery);
    setTerm(urlQuery);
  }

  const [open, setOpen] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [active, setActive] = useState(-1);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [failedTerm, setFailedTerm] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() =>
    signedIn || typeof window === "undefined" ? [] : readRecent(),
  );
  const [inspiration, setInspiration] = useState<{
    popular: string[];
    trending: string[];
  } | null>(null);

  const extrasLoaded = useRef(false);
  const cache = useRef(new Map<string, Omit<Answer, "term">>());
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = term.trim();
  const typing = trimmed.length >= 2;

  useEffect(() => {
    if (!typing) return;

    const key = trimmed.toLowerCase();
    const cached = cache.current.get(key);
    const controller = new AbortController();

    // Debounced and cancelled on the next keystroke, so a fast typist never
    // leaves a queue of stale answers racing to render. A term already
    // answered in this visit is shown straight from memory.
    const timer = setTimeout(
      async () => {
        if (cached) {
          setAnswer({ term: trimmed, ...cached });
          setActive(-1);
          return;
        }

        setLoading(true);
        try {
          const response = await fetch(
            `/api/search/suggest?q=${encodeURIComponent(trimmed)}`,
            { signal: controller.signal },
          );
          if (!response.ok) throw new Error(`Suggest answered ${response.status}`);

          const body = await response.json();
          const entry = {
            suggestions: (body.suggestions ?? []) as Suggestion[],
            correctedQuery: (body.correctedQuery ?? null) as string | null,
          };
          cache.current.set(key, entry);
          setAnswer({ term: trimmed, ...entry });
          setFailedTerm(null);
          setActive(-1);
        } catch {
          if (!controller.signal.aborted) setFailedTerm(trimmed);
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      },
      cached ? 0 : 160,
    );

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, typing]);

  // A full-screen search should not scroll the page underneath it.
  useEffect(() => {
    if (!overlay) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [overlay]);

  const current = typing && answer?.term === trimmed ? answer : null;

  const sections: Section[] = useMemo(() => {
    if (typing) {
      if (!current) return [];
      const of = (kind: Suggestion["kind"]) =>
        current.suggestions
          .filter((suggestion) => suggestion.kind === kind)
          .map((suggestion) => ({
            key: `${kind}:${suggestion.href}`,
            kind,
            label: suggestion.label,
            href: suggestion.href,
            suggestion,
          }));

      return [
        { key: "search", heading: "Searches", options: of("search") },
        { key: "product", heading: "Products", options: of("product") },
        { key: "category", heading: "Categories", options: of("category") },
        { key: "brand", heading: "Brands", options: of("brand") },
      ].filter((section) => section.options.length > 0);
    }

    const list = (kind: OptionKind, entries: string[]) =>
      entries.map((entry) => ({
        key: `${kind}:${entry}`,
        kind,
        label: entry,
        href: searchHref(entry),
      }));

    return [
      { key: "recent", heading: "Recent searches", options: list("recent", recent) },
      {
        key: "trending",
        heading: "Trending now",
        options: list("trending", inspiration?.trending ?? []),
      },
      {
        key: "popular",
        heading: "Popular searches",
        options: list("popular", inspiration?.popular ?? []),
      },
    ].filter((section) => section.options.length > 0);
  }, [typing, current, recent, inspiration]);

  // The order the keyboard moves through is the order they are painted in.
  const ordered = sections.flatMap((section) => section.options);
  const indexOf = new Map(ordered.map((option, index) => [option.key, index]));

  const noMatches = typing && current !== null && ordered.length === 0 && !loading;
  const failed = typing && failedTerm === trimmed && current === null && !loading;
  const listVisible = open && ordered.length > 0;
  const panelVisible =
    open && (listVisible || noMatches || failed || (overlay && !typing));

  const announcement = !open
    ? ""
    : failed
      ? "Suggestions are unavailable."
      : current
        ? ordered.length > 0
          ? `${ordered.length} suggestion${ordered.length === 1 ? "" : "s"} available.`
          : "No suggestions."
        : "";

  async function loadExtras() {
    const [popular, history] = await Promise.all([
      fetch("/api/search/popular").catch(() => null),
      signedIn ? fetch("/api/search/history").catch(() => null) : null,
    ]);

    if (popular?.ok) {
      const body = await popular.json().catch(() => null);
      if (body) {
        setInspiration({
          popular: Array.isArray(body.popular) ? body.popular : [],
          trending: Array.isArray(body.trending) ? body.trending : [],
        });
      }
    }

    if (history?.ok) {
      const body = await history.json().catch(() => null);
      if (Array.isArray(body?.history)) setRecent(body.history);
    }
  }

  function openPanel() {
    setOpen(true);
    if (window.matchMedia("(max-width: 767px)").matches) setOverlay(true);
    if (!extrasLoaded.current) {
      extrasLoaded.current = true;
      void loadExtras();
    }
  }

  function close() {
    setOpen(false);
    setOverlay(false);
    setActive(-1);
  }

  function remember(query: string) {
    if (looksPersonal(query)) return;
    const next = withRecent(recent, query);
    setRecent(next);
    // Signed in, the results page records it on the account.
    if (!signedIn) writeRecent(next);
  }

  function forget(query: string) {
    const next = recent.filter(
      (entry) => entry.toLowerCase() !== query.toLowerCase(),
    );
    setRecent(next);
    setActive(-1);
    if (signedIn) {
      void fetch(`/api/search/history?q=${encodeURIComponent(query)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    } else {
      writeRecent(next);
    }
    inputRef.current?.focus();
  }

  function clearRecent() {
    setRecent([]);
    setActive(-1);
    if (signedIn) {
      void fetch("/api/search/history", { method: "DELETE" }).catch(
        () => undefined,
      );
    } else {
      writeRecent([]);
    }
    inputRef.current?.focus();
  }

  function choose(option: Option) {
    const query = queryOf(option);
    if (query) {
      remember(query);
      setTerm(query);
    }
    close();
    inputRef.current?.blur();
    router.push(option.href);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          openPanel();
          return;
        }
        if (ordered.length > 0) {
          setActive((index) => (index + 1) % ordered.length);
        }
        return;
      case "ArrowUp":
        event.preventDefault();
        if (ordered.length > 0) {
          setActive((index) => (index <= 0 ? ordered.length - 1 : index - 1));
        }
        return;
      case "Enter":
        if (open && active >= 0 && ordered[active]) {
          event.preventDefault();
          choose(ordered[active]);
        }
        return;
      case "Escape":
        if (open) {
          event.preventDefault();
          close();
          if (overlay) inputRef.current?.blur();
        } else if (term) {
          event.preventDefault();
          setTerm("");
        }
        return;
      case "Delete":
        if (open && active >= 0 && ordered[active]?.kind === "recent") {
          event.preventDefault();
          forget(ordered[active].label);
        }
        return;
      case "Tab":
        close();
        return;
    }
  }

  function renderOption(option: Option) {
    const index = indexOf.get(option.key) ?? -1;
    const selected = index === active;
    const suggestion = option.suggestion;

    const row = `flex w-full items-center gap-3 px-3 text-left text-body text-ink transition-colors ${
      overlay ? "min-h-12 py-2" : "min-h-11 py-1.5"
    } ${selected ? "bg-blue-50" : "hover:bg-blue-50/60"}`;

    const content =
      option.kind === "product" ? (
        <>
          <span className="surface-studio flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-control">
            {suggestion?.thumbnailUrl ? (
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
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{option.label}</span>
            {suggestion?.hint ? (
              <span className="block truncate text-meta text-ink/70">
                {suggestion.hint}
              </span>
            ) : null}
          </span>
          {typeof suggestion?.priceBdt === "number" ? (
            <span className="shrink-0 text-meta font-semibold tabular-nums text-ink">
              {formatBdt(suggestion.priceBdt)}
            </span>
          ) : null}
        </>
      ) : option.kind === "category" ? (
        <>
          <IconArrowRight size={16} className="shrink-0 text-ink/70" />
          <span className="min-w-0 flex-1 truncate">
            {suggestion?.scope ? (
              <>
                {suggestion.scope} <span className="text-ink/70">in</span>{" "}
                <strong className="font-semibold">{option.label}</strong>
              </>
            ) : (
              <>
                {option.label}
                <span className="ml-2 text-meta text-ink/70">Category</span>
              </>
            )}
          </span>
        </>
      ) : option.kind === "brand" ? (
        <>
          <IconArrowRight size={16} className="shrink-0 text-ink/70" />
          <span className="min-w-0 flex-1 truncate">
            {option.label}
            <span className="ml-2 text-meta text-ink/70">Brand</span>
          </span>
        </>
      ) : (
        <>
          {option.kind === "recent" ? (
            <IconClock size={16} className="shrink-0 text-ink/70" />
          ) : (
            <IconSearch size={16} className="shrink-0 text-ink/70" />
          )}
          <span className="min-w-0 flex-1 truncate">
            <Completion label={option.label} typed={typing ? trimmed : ""} />
          </span>
        </>
      );

    const link = (
      <Link
        id={`${listId}-${index}`}
        role="option"
        aria-selected={selected}
        aria-describedby={option.kind === "recent" ? recentHintId : undefined}
        href={option.href}
        tabIndex={-1}
        onMouseEnter={() => setActive(index)}
        onClick={() => {
          const query = queryOf(option);
          if (query) {
            remember(query);
            setTerm(query);
          }
          close();
        }}
        className={`${row} ${option.kind === "recent" ? "pr-12" : ""}`}
      >
        {content}
      </Link>
    );

    if (option.kind !== "recent") return <div key={option.key}>{link}</div>;

    return (
      <div key={option.key} className="relative">
        {link}
        {/* A pointer affordance only: the keyboard route is Delete on the
            highlighted search, announced through the option's description. */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => forget(option.label)}
          className="absolute right-2 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-control text-ink/70 transition-colors hover:bg-blue-50 hover:text-ink"
        >
          <IconClose size={14} />
        </button>
      </div>
    );
  }

  const solid = overlay || !floating;

  return (
    <div
      ref={containerRef}
      onBlur={(event) => {
        if (overlay) return;
        if (!containerRef.current?.contains(event.relatedTarget as Node | null)) {
          close();
        }
      }}
      className={
        overlay
          ? "fixed inset-0 z-[70] flex flex-col bg-paper px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
          : "relative order-last w-full md:order-none md:ml-auto md:w-64 lg:w-80 xl:w-[26rem]"
      }
    >
      <div className="flex items-center gap-2">
        <Form
          action="/search"
          role="search"
          aria-label="Search the catalogue"
          onSubmit={(event) => {
            if (!trimmed) {
              event.preventDefault();
              inputRef.current?.focus();
              return;
            }
            remember(trimmed);
            close();
            inputRef.current?.blur();
          }}
          className="relative min-w-0 flex-1"
        >
          <label htmlFor="site-search" className="sr-only">
            Search products
          </label>
          <input
            ref={inputRef}
            id="site-search"
            name="q"
            type="search"
            role="combobox"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            maxLength={100}
            aria-expanded={listVisible}
            aria-controls={listVisible ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              listVisible && active >= 0 ? `${listId}-${active}` : undefined
            }
            aria-describedby={hintId}
            placeholder="Search products, brands or SKUs"
            value={term}
            onChange={(event) => {
              const next = event.target.value;
              setTerm(next);
              setActive(-1);
              setOpen(true);
              if (next.trim().length < 2) setLoading(false);
            }}
            onFocus={openPanel}
            onKeyDown={onKeyDown}
            className={`min-h-11 w-full rounded-control py-2 pl-10 pr-24 text-body transition-[background-color,border-color,color] duration-500 ease-[var(--ease-out-quint)] [&::-webkit-search-cancel-button]:appearance-none ${
              solid ? fieldBar : fieldFloating
            }`}
          />

          {/* Decorative: the field has a label and the button a name. */}
          <IconSearch
            size={18}
            className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${
              solid ? "text-ink/70" : "text-[color:var(--head-muted)]"
            }`}
          />

          <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
            {/* A quiet mark while a request is out. It replaces nothing and
                moves nothing, so a slow answer never shifts the controls. */}
            {loading ? (
              <span
                aria-hidden="true"
                className={`mx-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60 ${
                  solid ? "text-ink" : "text-[color:var(--head-fg)]"
                }`}
              />
            ) : null}
            {term ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setTerm("");
                  setActive(-1);
                  setLoading(false);
                  setOpen(true);
                  inputRef.current?.focus();
                }}
                className={`inline-flex size-9 items-center justify-center rounded-control transition-colors ${
                  solid
                    ? "text-ink/70 hover:bg-blue-50 hover:text-ink"
                    : "text-[color:var(--head-muted)] hover:bg-[color:var(--head-ghost)]"
                }`}
              >
                <IconClose size={16} />
              </button>
            ) : null}
            <SubmitButton floating={!solid} />
          </div>
        </Form>

        {overlay ? (
          <button
            type="button"
            onClick={() => {
              close();
              inputRef.current?.blur();
            }}
            className="inline-flex min-h-11 shrink-0 items-center rounded-control px-2 text-body font-medium text-blue-600"
          >
            Cancel
          </button>
        ) : null}
      </div>

      <p id={hintId} className="sr-only">
        Type two or more letters for suggestions, then use the up and down
        arrow keys to choose one.
      </p>
      <p id={recentHintId} className="sr-only">
        Press Delete to remove this from your recent searches.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {panelVisible ? (
        <div
          // Pressing inside the panel must not blur the field and close it.
          onMouseDown={(event) => event.preventDefault()}
          className={
            overlay
              ? "mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain"
              : "animate-rise absolute right-0 top-full z-40 mt-2 w-full overflow-hidden rounded-card border border-blue-300 bg-paper text-ink shadow-[var(--shadow-float)] md:w-[30rem] md:max-w-[calc(100vw-2rem)]"
          }
        >
          {current?.correctedQuery ? (
            <p className="px-3 pt-3 text-meta text-ink/70">
              Nothing matched “{trimmed}”. Showing suggestions for{" "}
              <strong className="font-semibold text-ink">
                “{current.correctedQuery}”
              </strong>
              .
            </p>
          ) : null}

          {!typing && recent.length > 0 ? (
            <div className="flex justify-end px-3 pt-2">
              <button
                type="button"
                onClick={clearRecent}
                className="inline-flex min-h-9 items-center rounded-control px-2 text-meta font-semibold text-blue-600 hover:bg-blue-50"
              >
                Clear recent searches
              </button>
            </div>
          ) : null}

          {listVisible ? (
            <div
              id={listId}
              role="listbox"
              aria-label="Search suggestions"
              className={overlay ? "pb-2" : "max-h-[min(28rem,70vh)] overflow-y-auto py-1"}
            >
              {sections.map((section) => (
                <div
                  key={section.key}
                  role="group"
                  aria-labelledby={`${listId}-${section.key}-heading`}
                >
                  <p
                    id={`${listId}-${section.key}-heading`}
                    className="px-3 pb-1 pt-2 text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-ink/70"
                  >
                    {section.heading}
                  </p>
                  {section.options.map(renderOption)}
                </div>
              ))}
            </div>
          ) : null}

          {noMatches ? (
            <p className="px-3 py-4 text-meta text-ink/70">
              Nothing matched “{trimmed}”. Press Enter to search the whole
              catalogue.
            </p>
          ) : null}

          {failed ? (
            <p className="px-3 py-4 text-meta text-ink/70">
              Suggestions are unavailable right now. Press Enter to search.
            </p>
          ) : null}

          {overlay && !typing && ordered.length === 0 ? (
            <p className="px-1 py-4 text-body text-ink/70">
              Search by product name, brand, SKU or category.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the header shows before the search box has read the address — the same
 * field, without suggestions. It only ever appears if a page is rendered
 * statically, which the storefront's pages are not today.
 */
export function SearchBoxFallback() {
  return (
    <div className="relative order-last w-full md:order-none md:ml-auto md:w-64 lg:w-80 xl:w-[26rem]">
      <form action="/search" role="search" aria-label="Search the catalogue" className="relative">
        <label htmlFor="site-search" className="sr-only">
          Search products
        </label>
        <input
          id="site-search"
          name="q"
          type="search"
          placeholder="Search products, brands or SKUs"
          className={`min-h-11 w-full rounded-control py-2 pl-10 pr-12 text-body ${fieldBar}`}
        />
        <IconSearch
          size={18}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/70"
        />
        <button
          type="submit"
          aria-label="Search"
          className="surface-brass absolute right-1 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-[8px] text-ink"
        >
          <IconSearch size={18} />
        </button>
      </form>
    </div>
  );
}
