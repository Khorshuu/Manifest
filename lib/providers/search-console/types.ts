/**
 * The Search Console boundary (D-096).
 *
 * Everything in `lib/search-console` talks to this interface and never to
 * Google. Three reasons, in order:
 *
 *  - The shop has to work with no Search Console at all. A provider that is
 *    not set up answers `NOT_CONFIGURED`, which is an expected state and not
 *    an error: SeoPulse, SearchPulse, the storefront and the knowledge base
 *    carry on exactly as before.
 *  - Credentials stay on the server, inside one implementation, and never
 *    reach a call site, a log line or the browser.
 *  - A provider never invents a measurement. If it cannot answer it says so,
 *    because a plausible-looking click count is worse than no click count.
 */

export type SearchConsoleDimension = "page" | "query" | "page_query";

/** One day's measurements for one page, one query, or one of each. */
export type SearchConsoleRow = {
  /** ISO date, YYYY-MM-DD, as the provider reported it. */
  date: string;
  /** The full address Google reported, or null for a query-only row. */
  page: string | null;
  query: string | null;
  clicks: number;
  impressions: number;
  /** Reported as a fraction; recomputed from clicks and impressions on store. */
  ctr: number;
  /** The impression-weighted average position, which cannot be recomputed. */
  position: number;
};

export type SearchConsoleRequest = {
  /** The Search Console property, e.g. `sc-domain:example.com`. */
  property: string;
  startDate: string;
  endDate: string;
  dimension: SearchConsoleDimension;
  /** How many rows to ask for in this request. */
  rowLimit: number;
  /** Where to continue from; the provider paginates by row offset. */
  startRow: number;
};

export type SearchConsoleFetch =
  | { status: "OK"; rows: SearchConsoleRow[]; hasMore: boolean }
  /** No provider or no credentials. Expected, and not an error. */
  | { status: "NOT_CONFIGURED"; message: string }
  /** Configured but unusable right now: quota, outage, permission withdrawn. */
  | { status: "UNAVAILABLE"; message: string }
  | { status: "FAILED"; message: string };

export type SearchConsoleConnection =
  | { status: "NOT_CONFIGURED"; message: string }
  | {
      status: "CONFIGURED";
      property: string;
      /** How the shop authenticates, in words. Never a credential. */
      account: string | null;
    };

export type SearchConsoleProvider = {
  readonly key: string;
  /**
   * What is configured, decided from the environment alone — no network call,
   * so a screen can render its connection state without waiting on Google.
   */
  connection(): SearchConsoleConnection;
  fetchPerformance(request: SearchConsoleRequest): Promise<SearchConsoleFetch>;
};

/** The dimension names each shape asks the provider for. */
export const DIMENSION_KEYS: Record<SearchConsoleDimension, string[]> = {
  page: ["date", "page"],
  query: ["date", "query"],
  page_query: ["date", "page", "query"],
};
