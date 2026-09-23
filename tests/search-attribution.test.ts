/**
 * Carrying a search from the result a shopper opened to the order they place
 * (D-093, risk R-14).
 *
 * The attribution figure is deliberately a floor: it counts only the path it
 * can honestly follow, and a shopper who blocks the first-party cookie or
 * reaches a product without clicking a result is simply not counted. That
 * limitation is intended and stays. What must be right is everything else —
 * the cookie must survive a round trip for the searches people actually type,
 * it must never attribute one product's search to another, and it must hold
 * nothing about the person.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A cookie jar standing in for the request's, with the same surface. */
const jar = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
      set: (name: string, value: string) => {
        store.set(name, value);
      },
    },
  };
});

vi.mock("next/headers", () => ({ cookies: async () => jar.api }));

import { rememberSearchAttribution, searchAttributionFor } from "@/lib/search/attribution";

const PRODUCT = "6d1f0a2e-4d4b-4d9a-9a4a-1b2c3d4e5f60";
const OTHER = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  jar.store.clear();
});

describe("remembering the search a product was opened from", () => {
  /*
   * A normalized search *is* words joined by spaces, so the separator inside
   * the cookie cannot be one. It is a NUL, which no search can contain and
   * which the cookie layer percent-encodes on the way out and decodes on the
   * way back — checked directly, because a separator that a browser round trip
   * mangles would turn the whole conversion figure into a silent zero rather
   * than into an error anybody would see.
   */
  it("survives a round trip for a search of several words", async () => {
    await rememberSearchAttribution("wireless noise cancelling headphones", PRODUCT);
    expect(await searchAttributionFor(PRODUCT)).toBe("wireless noise cancelling headphones");
  });

  it("survives a round trip for a search of one word", async () => {
    await rememberSearchAttribution("headphones", PRODUCT);
    expect(await searchAttributionFor(PRODUCT)).toBe("headphones");
  });

  it("stores the normalized search, not the raw typing", async () => {
    await rememberSearchAttribution("  WIRELESS   Headphones!  ", PRODUCT);
    expect(await searchAttributionFor(PRODUCT)).toBe("wireless headphones");
  });

  it("never attributes one product's search to another", async () => {
    await rememberSearchAttribution("wireless headphones", PRODUCT);
    expect(await searchAttributionFor(OTHER)).toBeNull();
  });

  it("attributes nothing when nothing was remembered", async () => {
    expect(await searchAttributionFor(PRODUCT)).toBeNull();
  });

  it("refuses a search that looks like it is about a person", async () => {
    await rememberSearchAttribution("someone@example.com", PRODUCT);
    expect(jar.store.size).toBe(0);
    expect(await searchAttributionFor(PRODUCT)).toBeNull();
  });

  it("holds the search and one product id, and nothing else", async () => {
    await rememberSearchAttribution("wireless headphones", PRODUCT);
    const [value] = [...jar.store.values()];
    // Exactly what the cookie is allowed to be: one search, one product. No
    // visitor id, no timestamp, no second product — it cannot accumulate a
    // browsing history because there is nowhere to put one.
    expect(value).toBe(`wireless headphones${String.fromCharCode(0)}${PRODUCT}`);
  });

  it("uses a separator no search can contain, and one a cookie survives", async () => {
    await rememberSearchAttribution("wireless headphones", PRODUCT);
    const [value] = [...jar.store.values()];
    const separator = String.fromCharCode(0);

    expect(value.split(separator)).toHaveLength(2);
    // The check that matters: this is what a browser actually carries. A
    // separator the cookie layer refused or rewrote would leave every order
    // unattributed and nothing would say so — the writer swallows its errors
    // on purpose, because attribution is never worth failing a request over.
    const { ResponseCookies } = await import("next/dist/compiled/@edge-runtime/cookies");
    const headers = new Headers();
    new ResponseCookies(headers).set("ms_attr", value);
    expect(headers.get("set-cookie")).toContain("%00");
  });

  it("is replaced rather than appended to when a second result is opened", async () => {
    await rememberSearchAttribution("wireless headphones", PRODUCT);
    await rememberSearchAttribution("travel kettle", OTHER);
    expect(jar.store.size).toBe(1);
    expect(await searchAttributionFor(PRODUCT)).toBeNull();
    expect(await searchAttributionFor(OTHER)).toBe("travel kettle");
  });

  it("ignores a cookie that has been tampered with", async () => {
    jar.store.set("ms_attr", "not-a-product-id");
    expect(await searchAttributionFor(PRODUCT)).toBeNull();
    jar.store.set("ms_attr", "");
    expect(await searchAttributionFor(PRODUCT)).toBeNull();
    jar.store.set("ms_attr", `${PRODUCT} `);
    expect(await searchAttributionFor(PRODUCT)).toBeNull();
  });
});
