import { and, asc, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { mediaObjects } from "@/db/schema";
import type { MediaProvider, StoredMedia, UploadInput } from "@/lib/providers/media/types";

/**
 * The media registry and its sweep (DECISIONS.md D-055).
 *
 * Every stored file gets a row. Nothing deletes a product photograph's file at
 * the moment the photograph is removed: an order placed last month recorded
 * that address, and deleting the file blanked its thumbnail. Instead the sweep
 * deletes a file once nothing in the database points at it — no product or
 * variant image, no order line, no homepage setting — and it has been that way
 * for a grace period. The grace period also covers the gap between a file
 * being stored and the row that uses it committing.
 */

/** Wraps a provider so every successful upload is recorded. */
export function withMediaRegistry(provider: MediaProvider): MediaProvider {
  return {
    name: provider.name,
    async upload(input: UploadInput): Promise<StoredMedia> {
      const stored = await provider.upload(input);
      try {
        await db.insert(mediaObjects).values({
          key: stored.key,
          provider: provider.name,
          url: stored.url,
          contentType: stored.contentType,
          bytes: stored.bytes,
          width: stored.width ?? null,
          height: stored.height ?? null,
          sha256: stored.sha256 ?? null,
        });
      } catch (error) {
        // An unrecorded file could never be swept, so it is not kept.
        await provider.delete(stored.key).catch(() => undefined);
        throw error;
      }
      return stored;
    },
    delete: (key) => provider.delete(key),
  };
}

/** True when some row still shows the file. Correlated on `media_objects`. */
const stillReferenced = sql`(
  exists (select 1 from product_images p where p.url = ${mediaObjects.url})
  or exists (select 1 from variant_images v where v.url = ${mediaObjects.url})
  or exists (select 1 from order_items o where o.image_url_snapshot = ${mediaObjects.url})
  or exists (select 1 from site_settings s where strpos(s.value_json::text, ${mediaObjects.key}) > 0)
)`;

export type MediaSweepReport = { examined: number; deleted: number; failed: number };

export async function sweepUnreferencedMedia(
  provider: MediaProvider,
  options: { now?: Date; graceHours?: number; limit?: number } = {},
): Promise<MediaSweepReport> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - (options.graceHours ?? 24) * 3_600_000);
  const oldEnough = lt(mediaObjects.createdAt, cutoff);

  // Only files the current provider can reach: rows left by another provider
  // (a site moved from disk to Blob) stay until that provider is configured.
  const candidates = await db
    .select({ key: mediaObjects.key })
    .from(mediaObjects)
    .where(and(eq(mediaObjects.provider, provider.name), oldEnough, sql`not ${stillReferenced}`))
    .orderBy(asc(mediaObjects.createdAt))
    .limit(options.limit ?? 200);

  let deleted = 0;
  let failed = 0;

  for (const { key } of candidates) {
    // Claimed by deleting the row, with the reference check repeated in the
    // same statement: a second sweep gets nothing back, and a file that gained
    // a reference since the list was read is left alone.
    const [claimed] = await db
      .delete(mediaObjects)
      .where(and(eq(mediaObjects.key, key), oldEnough, sql`not ${stillReferenced}`))
      .returning();
    if (!claimed) continue;

    try {
      await provider.delete(key);
      deleted += 1;
    } catch {
      // Put the row back, so the next sweep tries again.
      await db.insert(mediaObjects).values(claimed).onConflictDoNothing();
      failed += 1;
    }
  }

  return { examined: candidates.length, deleted, failed };
}
