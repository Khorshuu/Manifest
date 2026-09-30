import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_AUTOCOMPLETE,
  SEARCH_DEBOUNCE_MS,
  SEARCH_LOADING_DELAY_MS,
  SEARCH_MIN_CHARS,
  createAutocomplete,
  eligibleQuery,
  type AutocompleteState,
} from "@/lib/search/autocomplete";

/**
 * When the header search asks for suggestions and which answer it shows
 * (lib/search/autocomplete.ts). Fake timers throughout: nothing here waits for
 * real time to pass.
 */

type Answer = { labels: string[] };

type Call = {
  query: string;
  signal: AbortSignal;
  resolve: (answer: Answer) => void;
  reject: (error: unknown) => void;
};

function harness(options: { cacheLimit?: number } = {}) {
  const calls: Call[] = [];
  const states: AutocompleteState<Answer>[] = [];

  // Deliberately ignores the abort signal, like a response already on its
  // way back when the abort lands: the controller must drop it on its own.
  const fetchAnswer = vi.fn(
    (query: string, signal: AbortSignal) =>
      new Promise<Answer>((resolve, reject) => {
        calls.push({ query, signal, resolve, reject });
      }),
  );

  const controller = createAutocomplete<Answer>({
    fetchAnswer,
    onChange: (state) => states.push(state),
    cacheLimit: options.cacheLimit,
  });

  return {
    controller,
    calls,
    fetchAnswer,
    get state() {
      return states.at(-1) ?? IDLE_AUTOCOMPLETE;
    },
    states,
  };
}

/** Lets a settled fetch promise run its continuation. */
const flush = () => vi.advanceTimersByTimeAsync(0);

const abortError = () =>
  Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("constants", () => {
  it("waits exactly 250 ms and needs two characters", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(250);
    expect(SEARCH_MIN_CHARS).toBe(2);
    expect(SEARCH_LOADING_DELAY_MS).toBeLessThan(SEARCH_DEBOUNCE_MS);
  });

  it("trims only the ends of the query", () => {
    expect(eligibleQuery("")).toBeNull();
    expect(eligibleQuery("r")).toBeNull();
    expect(eligibleQuery("   ")).toBeNull();
    expect(eligibleQuery(" r ")).toBeNull();
    expect(eligibleQuery("rt")).toBe("rt");
    expect(eligibleQuery("  rtx  5070 ")).toBe("rtx  5070");
  });
});

describe("the debounce", () => {
  it("sends nothing for one character", async () => {
    const h = harness();
    h.controller.update("r");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetchAnswer).not.toHaveBeenCalled();
    expect(h.state).toEqual(IDLE_AUTOCOMPLETE);
  });

  it("sends nothing for whitespace", async () => {
    const h = harness();
    h.controller.update("      ");
    h.controller.update(" r  ");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetchAnswer).not.toHaveBeenCalled();
  });

  it("makes two characters eligible, but not before 250 ms", async () => {
    const h = harness();
    h.controller.update("rt");
    expect(h.state).toMatchObject({ query: "rt", answer: null, loading: false });

    await vi.advanceTimersByTimeAsync(249);
    expect(h.fetchAnswer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
    expect(h.calls[0].query).toBe("rt");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
  });

  it("restarts the wait on every keystroke", async () => {
    const h = harness();
    h.controller.update("rt");
    await vi.advanceTimersByTimeAsync(150);
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(249);
    expect(h.fetchAnswer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
    expect(h.calls[0].query).toBe("rtx");
  });

  it("sends one request for a run of fast typing", async () => {
    const h = harness();
    for (const value of ["r", "rt", "rtx", "rtx ", "rtx 5", "rtx 50", "rtx 507", "rtx 5070"]) {
      h.controller.update(value);
      await vi.advanceTimersByTimeAsync(60);
    }
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
    expect(h.calls[0].query).toBe("rtx 5070");
  });

  it("treats a paste as one query, still after the wait", async () => {
    const h = harness();
    h.controller.update("rtx 5070");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(h.fetchAnswer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
    expect(h.calls[0].query).toBe("rtx 5070");
  });

  it("does not ask again when only trailing space changed", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.controller.update("rtx ");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
  });
});

describe("superseded requests", () => {
  it("aborts the request out when a newer query replaces it", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const first = h.calls[0];
    expect(first.signal.aborted).toBe(false);

    h.controller.update("rtx 5070");
    expect(first.signal.aborted).toBe(true);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(2);
    expect(h.calls[1].query).toBe("rtx 5070");
  });

  it("does not report an abort as a failure", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.controller.update("rtx 5070");
    h.calls[0].reject(abortError());
    await flush();

    expect(h.states.some((state) => state.failed)).toBe(false);
    expect(h.state).toMatchObject({ query: "rtx 5070", failed: false });
  });

  it("reports a real failure for the current query only", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.calls[0].reject(new Error("Suggest answered 500"));
    await flush();

    expect(h.state).toEqual({
      query: "rtx",
      answer: null,
      loading: false,
      failed: true,
    });
  });

  it("never lets an older answer replace a newer one", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.controller.update("rtx 5070");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    h.calls[1].resolve({ labels: ["RTX 5070"] });
    await flush();
    expect(h.state).toMatchObject({ query: "rtx 5070", answer: { labels: ["RTX 5070"] } });

    // The first request ignored its abort and finishes last.
    h.calls[0].resolve({ labels: ["RTX 3060"] });
    await flush();
    expect(h.state).toMatchObject({ query: "rtx 5070", answer: { labels: ["RTX 5070"] } });
    expect(
      h.states.some((state) => state.answer?.labels.includes("RTX 3060")),
    ).toBe(false);
  });

  it("drops an older answer that lands while the newer one is still waiting", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.controller.update("rtx 5070");

    h.calls[0].resolve({ labels: ["RTX 3060"] });
    await flush();
    expect(h.state).toMatchObject({ query: "rtx 5070", answer: null });
  });

  it("does not cache an answer it dropped", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.controller.update("rtx 5070");
    h.calls[0].resolve({ labels: ["late"] });
    await flush();

    h.controller.update("rtx");
    expect(h.state.answer).toBeNull();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(h.calls.at(-1)?.query).toBe("rtx");
  });
});

describe("clearing and cancelling", () => {
  it("clears at once when the field is emptied", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.calls[0].resolve({ labels: ["RTX 5070"] });
    await flush();
    expect(h.state.answer).not.toBeNull();

    h.controller.update("");
    expect(h.state).toEqual(IDLE_AUTOCOMPLETE);
  });

  it("drops pending and in-flight work below two characters", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const first = h.calls[0];

    h.controller.update("rt");
    expect(first.signal.aborted).toBe(true);
    h.controller.update("r");
    expect(h.state).toEqual(IDLE_AUTOCOMPLETE);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);

    first.resolve({ labels: ["late"] });
    await flush();
    expect(h.state).toEqual(IDLE_AUTOCOMPLETE);
  });

  it("clears loading and failure at once", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + SEARCH_LOADING_DELAY_MS);
    expect(h.state.loading).toBe(true);

    h.controller.update("");
    expect(h.state).toEqual(IDLE_AUTOCOMPLETE);

    h.controller.update("rtx 5");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.calls.at(-1)!.reject(new Error("offline"));
    await flush();
    expect(h.state.failed).toBe(true);

    h.controller.update(" ");
    expect(h.state).toEqual(IDLE_AUTOCOMPLETE);
  });

  /*
   * Enter, the Search button and choosing a suggestion all close the list,
   * and the box cancels when the list closes: the search itself goes at once
   * and nothing is fetched for a list no one will see.
   */
  it("cancels a pending wait on submit, so nothing is sent", async () => {
    const h = harness();
    h.controller.update("rtx 5070");
    await vi.advanceTimersByTimeAsync(100);
    h.controller.cancel();

    expect(h.state).toEqual(IDLE_AUTOCOMPLETE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetchAnswer).not.toHaveBeenCalled();
  });

  it("aborts a request already out on submit and ignores its answer", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.controller.cancel();
    expect(h.calls[0].signal.aborted).toBe(true);

    h.calls[0].resolve({ labels: ["late"] });
    await flush();
    expect(h.state).toEqual(IDLE_AUTOCOMPLETE);
  });

  it("asks again when the list reopens on the same query", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(100);
    h.controller.cancel();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
  });

  it("never reports after it is disposed", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const reported = h.states.length;

    h.controller.dispose();
    expect(h.calls[0].signal.aborted).toBe(true);
    h.calls[0].resolve({ labels: ["late"] });
    await flush();
    h.controller.update("rtx 5070");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.states.length).toBe(reported);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the loading mark", () => {
  it("stays hidden for a fast answer", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + SEARCH_LOADING_DELAY_MS - 1);
    h.calls[0].resolve({ labels: ["RTX 5070"] });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.states.some((state) => state.loading)).toBe(false);
  });

  it("shows for a slow one, and goes with the answer", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + SEARCH_LOADING_DELAY_MS);
    expect(h.state).toMatchObject({ query: "rtx", loading: true });

    h.calls[0].resolve({ labels: ["RTX 5070"] });
    await flush();
    expect(h.state).toMatchObject({ loading: false, answer: { labels: ["RTX 5070"] } });
  });
});

describe("answers already fetched", () => {
  it("shows a repeated query at once without asking again", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.calls[0].resolve({ labels: ["RTX 5070"] });
    await flush();

    h.controller.update("rtx 5");
    h.controller.update("RTX");
    expect(h.state).toMatchObject({ query: "RTX", answer: { labels: ["RTX 5070"] } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure", async () => {
    const h = harness();
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.calls[0].reject(new Error("Suggest answered 429"));
    await flush();

    h.controller.update("");
    h.controller.update("rtx");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(2);
  });

  it("keeps a bounded number of answers, dropping the oldest", async () => {
    const h = harness({ cacheLimit: 2 });
    for (const query of ["aa", "bb", "cc"]) {
      h.controller.update(query);
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      h.calls.at(-1)!.resolve({ labels: [query] });
      await flush();
    }
    expect(h.fetchAnswer).toHaveBeenCalledTimes(3);

    h.controller.update("cc");
    h.controller.update("bb");
    expect(h.state.answer).toEqual({ labels: ["bb"] });

    h.controller.update("aa");
    expect(h.state.answer).toBeNull();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(h.fetchAnswer).toHaveBeenCalledTimes(4);
  });
});
