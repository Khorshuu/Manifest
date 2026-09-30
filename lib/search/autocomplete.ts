/**
 * When the header search asks the server for suggestions, and which answer it
 * is allowed to show.
 *
 * The field itself is never slowed down: every keystroke renders at once. Only
 * the request waits. It goes out once the shopper has stopped typing for
 * SEARCH_DEBOUNCE_MS, a newer query cancels the one before it, and an answer is
 * shown only while it still belongs to the query in the field — an older
 * request that finishes late is dropped however it got there.
 *
 * Kept free of React so the timing can be tested with fake timers in plain
 * Node; the header box (components/search-box.tsx) drives one instance.
 *
 * Client pacing is a courtesy to the server, not its protection: the endpoint
 * enforces its own two-character floor and per-visitor limit
 * (app/api/search/suggest/route.ts).
 */

/** Quiet time after the last keystroke before suggestions are requested. */
export const SEARCH_DEBOUNCE_MS = 250;

/** Shorter queries (after trimming) are never sent for suggestions. */
export const SEARCH_MIN_CHARS = 2;

/**
 * How long a request may be out before the field shows it is waiting, so a
 * fast answer does not flash a spinner. Not part of the debounce.
 */
export const SEARCH_LOADING_DELAY_MS = 150;

/** Answers kept for this visit, oldest dropped first. */
export const SEARCH_CACHE_LIMIT = 50;

export type AutocompleteState<T> = {
  /** The trimmed query everything below belongs to; null when idle. */
  query: string | null;
  answer: T | null;
  loading: boolean;
  failed: boolean;
};

export const IDLE_AUTOCOMPLETE = {
  query: null,
  answer: null,
  loading: false,
  failed: false,
} as const satisfies AutocompleteState<never>;

export type AutocompleteOptions<T> = {
  fetchAnswer: (query: string, signal: AbortSignal) => Promise<T>;
  onChange: (state: AutocompleteState<T>) => void;
  debounceMs?: number;
  loadingDelayMs?: number;
  cacheLimit?: number;
};

export type AutocompleteController = {
  /** The field's value changed, or the list was opened on it. */
  update: (value: string) => void;
  /** Drop pending and in-flight work and go idle: submit, close, clear. */
  cancel: () => void;
  /** As cancel, and never report again: unmount. */
  dispose: () => void;
};

/** The query a field value asks for, or null when it is too short to send. */
export function eligibleQuery(value: string): string | null {
  const query = value.trim();
  return query.length >= SEARCH_MIN_CHARS ? query : null;
}

const cacheKey = (query: string) => query.toLowerCase();

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createAutocomplete<T>({
  fetchAnswer,
  onChange,
  debounceMs = SEARCH_DEBOUNCE_MS,
  loadingDelayMs = SEARCH_LOADING_DELAY_MS,
  cacheLimit = SEARCH_CACHE_LIMIT,
}: AutocompleteOptions<T>): AutocompleteController {
  const cache = new Map<string, T>();
  let state: AutocompleteState<T> = IDLE_AUTOCOMPLETE;
  let disposed = false;

  // Every new query, and every cancel, starts a new generation. A callback
  // from an older one — a timer that slipped through, a response that
  // finished before its abort took effect — finds the number moved on and
  // does nothing. This, not the abort, is what keeps an old answer off screen.
  let generation = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let loadingTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;

  function set(next: AutocompleteState<T>) {
    if (disposed) return;
    if (
      next.query === state.query &&
      next.answer === state.answer &&
      next.loading === state.loading &&
      next.failed === state.failed
    ) {
      return;
    }
    state = next;
    onChange(state);
  }

  function stop() {
    generation += 1;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (loadingTimer !== null) clearTimeout(loadingTimer);
    debounceTimer = null;
    loadingTimer = null;
    inFlight?.abort();
    inFlight = null;
  }

  function remember(query: string, answer: T) {
    const key = cacheKey(query);
    cache.delete(key);
    cache.set(key, answer);
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function request(query: string, mine: number) {
    const controller = new AbortController();
    inFlight = controller;
    loadingTimer = setTimeout(() => {
      loadingTimer = null;
      if (mine === generation) set({ ...state, loading: true });
    }, loadingDelayMs);

    let answer: T;
    try {
      answer = await fetchAnswer(query, controller.signal);
    } catch (error) {
      // A cancelled request is not a failure the shopper needs to hear about.
      if (mine !== generation || controller.signal.aborted || isAbort(error)) return;
      finish();
      set({ query, answer: null, loading: false, failed: true });
      return;
    }

    if (mine !== generation) return;
    // Failures are never cached, so the next attempt asks again.
    remember(query, answer);
    finish();
    set({ query, answer, loading: false, failed: false });
  }

  function finish() {
    if (loadingTimer !== null) clearTimeout(loadingTimer);
    loadingTimer = null;
    inFlight = null;
  }

  return {
    update(value) {
      if (disposed) return;
      const query = eligibleQuery(value);

      if (query === null) {
        stop();
        set(IDLE_AUTOCOMPLETE);
        return;
      }

      // Same query, already waiting or answered: nothing new to ask.
      if (query === state.query) return;

      stop();
      const mine = generation;

      // An answer already fetched this visit is shown at once, without
      // waiting or asking the server again.
      const cached = cache.get(cacheKey(query));
      if (cached !== undefined) {
        remember(query, cached);
        set({ query, answer: cached, loading: false, failed: false });
        return;
      }

      set({ query, answer: null, loading: false, failed: false });
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (mine === generation) void request(query, mine);
      }, debounceMs);
    },

    cancel() {
      if (disposed) return;
      stop();
      set(IDLE_AUTOCOMPLETE);
    },

    dispose() {
      stop();
      disposed = true;
    },
  };
}
