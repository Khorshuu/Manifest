import { createHash } from "node:crypto";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db";
import { mediaObjects } from "@/db/schema";
import { queryRows, type Executor } from "@/lib/pkb/common";
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

// -------------------------------------------------------------- coverage

export type MediaCoverage = {
  /** Distinct addresses some row in the database shows. */
  referenced: number;
  /** Of those, how many the registry knows about. */
  registered: number;
  /**
   * Addresses this provider stores that have no registry row. These are the
   * problem: nothing records them, so the sweep can never reclaim them, and
   * their size is unknown to every report that asks.
   */
  unregisteredOwned: number;
  /**
   * Addresses nothing stores on this shop's behalf — a file that shipped with
   * the site under `public/`, a seeded illustration, an address entered by
   * hand, or another provider's store after a move. Expected to have no row,
   * and a row must never be invented for one: a row is what makes the sweep
   * willing to delete a file.
   */
  foreignOrStatic: number;
  /** Registered files whose dimensions were never established. */
  registeredWithoutDimensions: number;
  /** Up to ten examples of the unregistered owned addresses, for a report. */
  samples: string[];
};

/** Every address the database shows, from the places the sweep also looks. */
async function referencedUrls(executor: Executor = db): Promise<string[]> {
  const rows = await queryRows<{ url: string }>(
    executor,
    sql`
      select distinct url from (
        select url from product_images
        union all select url from variant_images
        union all select image_url_snapshot as url from order_items where image_url_snapshot is not null
      ) as shown
      where url is not null and url <> ''
    `,
  );
  return rows.map((row) => row.url);
}

/**
 * How much of what the shop shows the media registry actually knows about
 * (risk R-11).
 *
 * The answer for a freshly seeded database is "none of it", and that is
 * correct: the seed's illustrations are files in `public/`, committed to the
 * repository, which never went through an upload and must never gain a
 * registry row — the sweep deletes what it has a row for. What matters is the
 * `unregisteredOwned` count: a file this provider stores with no row behind it
 * is a file nothing can ever reclaim, and its size is unknown to the image
 * reports. That number should be zero, and `registerExistingMedia` is how it
 * gets back to zero without inventing anything.
 */
export async function mediaCoverage(
  provider: MediaProvider,
  executor: Executor = db,
): Promise<MediaCoverage> {
  const urls = await referencedUrls(executor);
  const known = new Set(
    (await queryRows<{ url: string }>(executor, sql`select url from media_objects`)).map((row) => row.url),
  );

  const unregisteredOwned: string[] = [];
  let foreignOrStatic = 0;
  let registered = 0;

  for (const url of urls) {
    if (known.has(url)) {
      registered += 1;
      continue;
    }
    if (provider.keyFor?.(url)) unregisteredOwned.push(url);
    else foreignOrStatic += 1;
  }

  const [dimensions] = await queryRows<{ n: number }>(
    executor,
    sql`select count(*)::int as n from media_objects where width is null or height is null`,
  );

  return {
    referenced: urls.length,
    registered,
    unregisteredOwned: unregisteredOwned.length,
    foreignOrStatic,
    registeredWithoutDimensions: Number(dimensions?.n ?? 0),
    samples: unregisteredOwned.slice(0, 10),
  };
}

/**
 * What a file is, read from the file. Never from its name.
 *
 * `sharp().metadata()` decodes the header only, so this is cheap and it is a
 * measurement rather than a guess. A file that cannot be read or is not an
 * image at all yields nothing, and the row is written with its measurements
 * unknown — which every report already tells apart from a number.
 */
async function measure(
  provider: MediaProvider,
  key: string,
): Promise<{ contentType: string | null; bytes: number | null; width: number | null; height: number | null; sha256: string | null }> {
  const unknown = { contentType: null, bytes: null, width: null, height: null, sha256: null };
  if (!provider.read) return unknown;

  const data = await provider.read(key).catch(() => null);
  if (!data) return unknown;

  const meta = await sharp(data)
    .metadata()
    .catch(() => null);

  return {
    // sharp's format names are the IANA subtypes for every format this system
    // stores or accepts, so the type is the decoder's answer rather than the
    // filename's claim.
    contentType: meta?.format ? `image/${meta.format}` : null,
    bytes: data.length,
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

/**
 * Records the files this provider stores that have no registry row (risk R-11).
 *
 * Only addresses the provider says it owns, so a file shipped with the site is
 * never registered and so never becomes something the sweep may delete — a row
 * is what makes the sweep willing to delete a file, and inventing one for a
 * committed asset would be a way to lose it.
 *
 * What goes in the row is read from the file where the provider can hand the
 * bytes back, and left null where it cannot. Nothing is inferred from the
 * address: a `.webp` in a filename is a claim, not a measurement, and a
 * plausible number in a report is worse than an absent one.
 *
 * Idempotent: a second run registers nothing, because the key is unique.
 */
export async function registerExistingMedia(
  provider: MediaProvider,
  options: { limit?: number; executor?: Executor } = {},
): Promise<{ registered: number; skipped: number; measured: number }> {
  const executor = options.executor ?? db;
  const urls = await referencedUrls(executor);
  const known = new Set(
    (await queryRows<{ url: string }>(executor, sql`select url from media_objects`)).map((row) => row.url),
  );

  let registered = 0;
  let skipped = 0;
  let measured = 0;
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5_000);

  for (const url of urls) {
    if (registered >= limit) break;
    if (known.has(url)) continue;
    const key = provider.keyFor?.(url);
    if (!key) {
      skipped += 1;
      continue;
    }

    const read = await measure(provider, key);
    const [row] = await executor
      .insert(mediaObjects)
      .values({
        key,
        provider: provider.name,
        url,
        contentType: read.contentType ?? "application/octet-stream",
        bytes: read.bytes ?? 0,
        width: read.width,
        height: read.height,
        sha256: read.sha256,
      })
      .onConflictDoNothing()
      .returning({ key: mediaObjects.key });

    if (!row) {
      skipped += 1;
      continue;
    }
    registered += 1;
    if (read.width !== null && read.height !== null) measured += 1;
  }

  return { registered, skipped, measured };
}
