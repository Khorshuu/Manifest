/**
 * A per-process speed bump for the public search endpoints.
 *
 * The login limiter counts in the database because an attacker spreading
 * attempts across instances is the threat there (lib/rate-limit.ts). Here the
 * threat is one client hammering suggestions or click beacons, and a database
 * write per keystroke would double the cost of the thing being protected. So
 * this counts in memory: exact on one server, approximate across several,
 * which is the right trade for an endpoint that only ever reads public data.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function allowRequest(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  // The end-to-end server runs many browsers from one address and one user
  // agent — one "visitor" to this counter. Same switch as the login limiter,
  // and ignored in production.
  if (
    process.env.RATE_LIMIT_DISABLED === "1" &&
    process.env.NODE_ENV !== "production"
  ) {
    return true;
  }

  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 10_000) {
      for (const [entry, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(entry);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= limit;
}

/** For tests: forget every count. */
export function resetThrottle(): void {
  buckets.clear();
}
