import type { SQL, Table } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { queryRows } from "@/lib/pkb/common";

/**
 * Deleting old rows in bounded batches (Stage 8, D-111).
 *
 * Every prune in the hourly maintenance job used to be one statement that
 * deleted everything past its retention window and asked for an id back for
 * each row — only ever to count them. That is two unbounded things in one
 * place: a transaction whose size is decided by how much has accumulated, and
 * an array in memory the same size.
 *
 * Measured on the bench database, pruning 500,000 Search Console measurements
 * took 2,177 ms and added 106 MB to the heap for the identifiers of rows that
 * had just been deleted. The table's size is driven by Google rather than by
 * this shop's catalogue, so five million rows is an ordinary amount to find
 * after a gap — about a gigabyte, inside a job that on a serverless platform
 * has a few hundred megabytes and a time limit.
 *
 * So a prune now walks the table in batches: each batch is its own statement,
 * its own transaction and its own lock, and the loop stops when a batch comes
 * back short. `ctid` is the physical row address, which makes the second
 * statement a direct fetch rather than a second pass over the condition.
 *
 * It returns how many rows went, and whether it stopped at the ceiling rather
 * than because there was nothing left — an operator seeing `more` knows the
 * next run has work waiting, which is the honest version of a prune that used
 * to appear to have finished.
 */

export const PRUNE_BATCH = 10_000;

/** A ceiling on one call, so a first prune of a huge table cannot run for ever. */
export const PRUNE_MAX_BATCHES = 200;

export type PruneResult = { removed: number; more: boolean };

export async function pruneInBatches(
  table: Table,
  condition: SQL,
  options: { batch?: number; maxBatches?: number } = {},
): Promise<PruneResult> {
  const batch = Math.min(Math.max(options.batch ?? PRUNE_BATCH, 100), 50_000);
  const maxBatches = Math.max(options.maxBatches ?? PRUNE_MAX_BATCHES, 1);
  let removed = 0;

  for (let pass = 0; pass < maxBatches; pass += 1) {
    const rows = await queryRows<{ gone: number }>(
      db,
      sql`
        with doomed as (
          select ctid from ${table} where ${condition} limit ${batch}
        )
        delete from ${table} where ctid in (select ctid from doomed)
        returning 1 as gone
      `,
    );
    removed += rows.length;
    if (rows.length < batch) return { removed, more: false };
  }

  return { removed, more: true };
}
