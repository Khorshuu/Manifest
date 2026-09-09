import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * The instant a page is being rendered at, taken from the database.
 *
 * Two reasons it comes from there rather than from `Date.now()`.
 *
 * The first is correctness. Everything else that decides whether a preorder
 * window is open — `closingSoon` in the card aggregates, `isClosed` on the
 * public variants — is computed in SQL precisely so the whole system agrees on
 * one clock (docs/BUSINESS_LOGIC.md). A countdown started from the web
 * server's clock could disagree with the badge printed beside it.
 *
 * The second is that reading a clock during render is not a pure operation,
 * and React's rules forbid it: a component that re-renders would silently get
 * a different answer. Awaiting it in the server component's data-loading phase
 * is both allowed and honest about what it is.
 */
export async function serverInstant(): Promise<number> {
  const rows = await db.execute<{ now: Date }>(sql`select now() as now`);
  const first = rows[0] as { now: Date | string } | undefined;
  if (!first) return 0;
  return new Date(first.now).getTime();
}
