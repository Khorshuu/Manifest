import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, productVariants, searchEvents } from "@/db/schema";
import type { Executor } from "@/lib/pkb/common";
import { logEvent } from "@/lib/observability/log";
import { pruneInBatches } from "@/lib/prune";
import { looksPersonal, normalizeText } from "./normalize";
import { queryRows } from "./sql";
import { analyticsWindow } from "./visitor";

/**
 * What people do with a search, beyond running it (D-093).
 *
 * `search_queries` already counts searches and `search_clicks` counts a result
 * being opened. This adds the four the report could not answer: whether people
 * filter, whether they rephrase, whether a search leads to a cart, and whether
 * it leads to money.
 *
 * Three rules hold throughout, and they are the same ones D-029 set:
 *
 *  * a visitor is a daily-rotating keyed hash, never an account;
 *  * a search shaped like an email address or a phone number is not recorded
 *    at all, in any of these;
 *  * nothing here may break a search or a checkout. Every write swallows its
 *    own failure, because a shopper who cannot be counted should still get
 *    their results and still be able to pay.
 *
 * None of it reaches the Product Knowledge Base (invariant I-9). The knowledge
 * base learns from these only through the zero-result review screen, where a
 * person decides.
 */

/** Two searches by one visitor inside this window are one search, refined. */
const REFINEMENT_WINDOW_MINUTES = 30;

async function record(values: typeof searchEvents.$inferInsert): Promise<void> {
  try {
    await db.insert(searchEvents).values(values).onConflictDoNothing();
  } catch (error) {
    await logEvent("warn", "search.event_log_failed", { error });
  }
}

/**
 * A filter was applied to a set of results. Only the filter *keys* are kept —
 * "brand and colour were used", not which brand, because the combination of
 * values a person picks is far more identifying than the fact that they
 * filtered at all.
 */
export async function logFilterUse(entry: {
  query: string;
  keys: string[];
  visitorHash: string;
  now?: Date;
}): Promise<void> {
  const normalized = normalizeText(entry.query);
  if (!normalized || looksPersonal(entry.query)) return;

  const keys = [...new Set(entry.keys)].sort().slice(0, 12);
  if (keys.length === 0) return;

  await record({
    eventType: "filter",
    queryNorm: normalized,
    visitorHash: entry.visitorHash,
    detail: { keys },
    windowStart: analyticsWindow(entry.now ?? new Date()),
    createdAt: entry.now ?? new Date(),
  });
}

/**
 * The same visitor searched for something else shortly after. Recorded against
 * the *new* search, with the one it replaced in the detail, because the
 * interesting question is "what did they end up asking for".
 */
export async function logRefinement(entry: {
  query: string;
  visitorHash: string;
  now?: Date;
}): Promise<void> {
  const normalized = normalizeText(entry.query);
  if (!normalized || looksPersonal(entry.query)) return;

  const now = entry.now ?? new Date();

  try {
    const [previous] = await queryRows<{ query_norm: string; results_count: number }>(sql`
      select query_norm, results_count
      from search_queries
      where visitor_hash = ${entry.visitorHash}
        and query_norm <> ${normalized}
        and created_at > ${now.toISOString()}::timestamptz
            - make_interval(mins => ${REFINEMENT_WINDOW_MINUTES})
        and created_at <= ${now.toISOString()}::timestamptz
      order by created_at desc
      limit 1
    `);
    if (!previous) return;

    await record({
      eventType: "refine",
      queryNorm: normalized,
      visitorHash: entry.visitorHash,
      detail: {
        from: previous.query_norm,
        fromFoundNothing: Number(previous.results_count) === 0,
      },
      windowStart: analyticsWindow(now),
      createdAt: now,
    });
  } catch (error) {
    await logEvent("warn", "search.refinement_log_failed", { error });
  }
}

/** A result of a search was put in a cart. */
export async function logAddToCart(entry: {
  query: string;
  productId: string;
  visitorHash: string;
  now?: Date;
}): Promise<void> {
  const normalized = normalizeText(entry.query);
  if (!normalized || looksPersonal(entry.query)) return;

  await record({
    eventType: "add_to_cart",
    queryNorm: normalized,
    productId: entry.productId,
    visitorHash: entry.visitorHash,
    windowStart: analyticsWindow(entry.now ?? new Date()),
    createdAt: entry.now ?? new Date(),
  });
}

/**
 * Money arrived for an order, so the searches its lines were found through
 * converted (D-093).
 *
 * Runs inside the transaction that confirms the payment, which is what makes
 * it idempotent: the phrase is written as an event and erased from the order
 * line in one step, so a webhook delivered twice cannot count the same order
 * twice. The event carries no visitor — by now it is a fact about the
 * catalogue, not about a person — and clearing the column means no order keeps
 * a lasting record of what its customer searched for.
 */
export async function countSearchConversions(
  executor: Executor,
  orderId: string,
): Promise<number> {
  const lines: { queryNorm: string; productId: string; units: number }[] =
    await executor
      .select({
        queryNorm: orderItems.searchQueryNorm,
        productId: productVariants.productId,
        units: orderItems.quantity,
      })
      .from(orderItems)
      .innerJoin(productVariants, eq(orderItems.variantId, productVariants.id))
      .where(and(eq(orderItems.orderId, orderId), isNotNull(orderItems.searchQueryNorm)));

  if (lines.length === 0) return 0;

  const now = new Date();
  await executor.insert(searchEvents).values(
    lines.map((line) => ({
      eventType: "purchase" as const,
      queryNorm: line.queryNorm,
      productId: line.productId,
      visitorHash: null,
      units: line.units,
      windowStart: analyticsWindow(now),
      createdAt: now,
    })),
  );

  await executor
    .update(orderItems)
    .set({ searchQueryNorm: null })
    .where(eq(orderItems.orderId, orderId));

  return lines.length;
}

/**
 * Deletes search events older than the same six months the query log keeps.
 * Purchase rows go too: they are a trend, not a ledger, and the orders
 * themselves remain the record of what was sold.
 */
export async function pruneSearchEvents(olderThanDays = 180): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const removed = await pruneInBatches(searchEvents, lt(searchEvents.createdAt, cutoff));
    return removed.removed;
  } catch (error) {
    await logEvent("warn", "search.event_prune_failed", { error });
    return 0;
  }
}
