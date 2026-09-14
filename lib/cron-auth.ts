import { timingSafeEqual } from "node:crypto";

/**
 * Whether a scheduler's request carries the shared secret.
 *
 * Not authenticated as a user, because a scheduler is not a person: it sends
 * `Authorization: Bearer <CRON_SECRET>`, the format Vercel Cron and most other
 * schedulers use. No secret configured means closed, not open — an endpoint
 * anyone can trigger is worse than none — and the comparison is constant-time.
 */
export function isAuthorisedScheduler(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length === 0 || !header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
