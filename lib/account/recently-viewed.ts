/**
 * "Recently viewed", kept in a cookie the browser holds.
 *
 * The cookie carries product ids only — never a price or a title — and every
 * id is resolved through the public predicate when read
 * (`listProductCardsByIds`), so a tampered cookie can at worst show nothing.
 */

export const RECENTLY_VIEWED_COOKIE = "recently_viewed";
export const RECENTLY_VIEWED_LIMIT = 12;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses the cookie into at most the limit of well-formed, distinct ids. */
export function parseRecentlyViewed(value: string | undefined | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of decodeURIComponent(value).split(",")) {
    const id = part.trim();
    if (UUID.test(id)) seen.add(id.toLowerCase());
    if (seen.size >= RECENTLY_VIEWED_LIMIT) break;
  }
  return [...seen];
}

/** Puts an id at the front of the list, dropping its older copy. */
export function pushRecentlyViewed(current: string[], id: string): string[] {
  if (!UUID.test(id)) return current;
  const lower = id.toLowerCase();
  return [lower, ...current.filter((entry) => entry !== lower)].slice(
    0,
    RECENTLY_VIEWED_LIMIT,
  );
}
