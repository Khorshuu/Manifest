import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  notifications,
  productVariants,
  products,
  waitlistEntries,
} from "@/db/schema";
import { composeWaitlistMessage } from "./templates";

/**
 * Telling the waitlist that places have opened up.
 *
 * The policy is recorded in DECISIONS.md D-011, and the short version is
 * **notify, do not hold**. When a place frees, everyone at the front of the
 * queue is written to and the place stays open to whoever orders first. The
 * alternative — reserving a place for the next person for some period — needs
 * a second kind of reservation with its own expiry and its own scheduler, and
 * the spec does not ask for one. If that turns out to be wanted, the queue
 * order is already recorded and nothing here has to be undone.
 *
 * Like every other message in this system it goes through the outbox inside
 * the caller's transaction (DECISIONS.md D-009), so a message exists if and
 * only if the capacity really was returned.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the base
   database or an open transaction; they differ only in generics */
type Executor = any;

export type WaitlistNotice = {
  entryId: string;
  recipient: string;
};

/**
 * Queues a message for the first `places` people waiting on a variant, and
 * marks them notified so nobody is told twice.
 *
 * Returns an empty list when there is nobody waiting, when no places actually
 * opened, or when the variant has since been archived — all of which are
 * ordinary, so none of them throws.
 */
export async function queueWaitlistNotifications(
  tx: Executor,
  variantId: string,
  places: number,
): Promise<WaitlistNotice[]> {
  if (!Number.isInteger(places) || places <= 0) return [];

  const [variant] = await tx
    .select({
      id: productVariants.id,
      label: productVariants.sku,
      archivedAt: productVariants.archivedAt,
      isEnabled: productVariants.isEnabled,
      productTitle: products.title,
      productSlug: products.slug,
      productStatus: products.status,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, variantId))
    .limit(1);

  // Nothing to point anyone at. Telling someone a place is free on a product
  // that has been withdrawn is worse than staying quiet.
  if (!variant) return [];
  if (variant.archivedAt || !variant.isEnabled) return [];
  if (variant.productStatus !== "preorder_open") return [];

  const waiting = await tx
    .select({
      id: waitlistEntries.id,
      email: waitlistEntries.email,
      userId: waitlistEntries.userId,
    })
    .from(waitlistEntries)
    .where(
      sql`${waitlistEntries.variantId} = ${variantId}
          and ${waitlistEntries.notifiedAt} is null`,
    )
    // Oldest first: the queue is the order people joined it.
    .orderBy(asc(waitlistEntries.createdAt))
    .limit(places);

  if (waiting.length === 0) return [];

  const message = composeWaitlistMessage({
    productTitle: variant.productTitle,
    variantLabel: variant.label,
    productSlug: variant.productSlug,
    places,
  });

  const rows = await tx
    .insert(notifications)
    .values(
      waiting.map((entry: { id: string; email: string; userId: string | null }) => ({
        userId: entry.userId,
        recipient: entry.email,
        channel: "email" as const,
        template: "waitlist.places_available",
        subject: message.subject,
        body: message.body,
        // Keyed on the entry, so the same person is never told twice about the
        // same wait even if capacity is released repeatedly.
        dedupeKey: `waitlist:${entry.id}`,
      })),
    )
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({
      recipient: notifications.recipient,
      dedupeKey: notifications.dedupeKey,
    });

  // Only the entries that actually produced a message are marked notified, so
  // a row that lost the dedupe race stays in the queue for next time.
  const notified = new Set(
    rows.map((row: { dedupeKey: string }) =>
      row.dedupeKey.replace(/^waitlist:/, ""),
    ),
  );
  const ids = waiting
    .map((entry: { id: string }) => entry.id)
    .filter((id: string) => notified.has(id));

  if (ids.length === 0) return [];

  await tx
    .update(waitlistEntries)
    .set({ notifiedAt: new Date() })
    .where(inArray(waitlistEntries.id, ids));

  return waiting
    .filter((entry: { id: string }) => notified.has(entry.id))
    .map((entry: { id: string; email: string }) => ({
      entryId: entry.id,
      recipient: entry.email,
    }));
}
