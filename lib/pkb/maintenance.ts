import { sql } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { LEGACY, queryRows, type Executor } from "./common";
import { syncLegacyFamilies } from "./families";
import { legacyStructuredFields, loadProjections, sameStructuredFields, type LegacyStructuredFields } from "./projection";
import { enqueueUniquePending } from "@/lib/jobs/runner";
import { processSearchQueue } from "@/lib/search/maintenance";
import { processKnowledgeQueue } from "./sync";
import { ensureSystemVocabulary, LEGACY_DETAIL_DEFINITIONS, LEGACY_DETAIL_IDENTIFIERS } from "./vocabulary";

/**
 * Backfill, the background job, clean-up after a deleted listing, and the
 * reconciliation report that says whether the knowledge base mirrors the
 * listings without loss (D-069).
 */

/**
 * The scheduled job: keep mirrored families current, then work the queue.
 * Handles imports, scripts and category moves no staff transaction synced.
 */
export async function runKnowledgeSync(options: { limit?: number; timeBudgetMs?: number } = {}) {
  const families = await db.transaction((tx) => syncLegacyFamilies(tx, LEGACY));
  const queue = await processKnowledgeQueue(db, { limit: options.limit ?? 200, timeBudgetMs: options.timeBudgetMs ?? 45_000 });
  return { families, queue };
}

/**
 * Imports every listing (idempotent: already-mirrored listings are no-ops).
 * Values arrive as LEGACY with UNKNOWN_LEGACY origin — never VERIFIED (I-3).
 *
 * The search index is *queued* rather than rebuilt per listing (risk R-13,
 * migration 0040). Rebuilding it at each listing's own commit is right when a
 * member of staff accepts one claim and wrong forty thousand facts in a row:
 * the work is thrown away as soon as the next listing is synced, and it is the
 * difference between 305 s and 181 s on the 5,000-listing scale database. The
 * report says how many listings are waiting, so an import never claims the
 * search index is current when it is not, and `drainSearch` finishes the job
 * for a caller that would rather wait than leave it to the worker.
 */
export async function backfillKnowledge(
  options: { batch?: number; log?: (line: string) => void; drainSearch?: boolean } = {},
): Promise<{
  processed: number;
  failed: number;
  remaining: number;
  durationMs: number;
  searchQueued: number;
  searchRebuilt: number;
}> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  await db.transaction((tx) => ensureSystemVocabulary(tx));
  const families = await db.transaction((tx) => syncLegacyFamilies(tx, LEGACY));
  log(`Families: ${JSON.stringify(families)}`);
  await db.execute(sql`select pkb_queue_listings(array(select id from ${products}))`);

  let processed = 0;
  let failed = 0;
  let remaining = Number.POSITIVE_INFINITY;
  for (let round = 0; remaining > 0; round++) {
    const report = await processKnowledgeQueue(db, {
      limit: options.batch ?? 200,
      timeBudgetMs: 10 * 60_000,
      workerId: "pkb-backfill",
      bulk: true,
    });
    processed += report.processed;
    failed += report.failed;
    remaining = report.remaining;
    log(`Round ${round + 1}: ${report.processed} synced, ${report.failed} failed, ${report.remaining} queued.`);
    if (report.processed === 0) break;
  }

  let searchRebuilt = 0;
  if (options.drainSearch) {
    for (;;) {
      const pass = await processSearchQueue({ limit: 5_000, budgetMs: 120_000, continueWhenMore: false });
      searchRebuilt += pass.rebuilt;
      log(`Search index: ${pass.rebuilt} rebuilt, ${pass.remaining} queued.`);
      if (pass.remaining === 0 || pass.rebuilt === 0) break;
    }
  } else {
    // Left for `search.process_queue`; ask it to start rather than waiting for
    // the ten-minute sweep.
    await enqueueUniquePending({ kind: "search.process_queue" });
  }

  const [queued] = await queryRows<{ n: number }>(
    db,
    sql`select count(*)::int as n from product_search_queue`,
  );

  return {
    processed,
    failed,
    remaining: Number.isFinite(remaining) ? remaining : 0,
    durationMs: Date.now() - started,
    searchQueued: Number(queued?.n ?? 0),
    searchRebuilt,
  };
}

/**
 * Removes the knowledge record of a deleted listing when it holds nothing but
 * what was mirrored from that listing. A record with knowledge of its own —
 * evidence, claims, relationships, aliases, values set in the knowledge base,
 * another listing — is kept: the asset outlives what Manifest sells.
 */
export async function releaseListingKnowledge(executor: Executor, pkbProductId: string | null): Promise<boolean> {
  if (!pkbProductId) return false;
  const brands = await queryRows<{ id: string }>(
    executor,
    sql`select distinct value_brand_id as id from pkb_facts where pkb_product_id = ${pkbProductId} and value_brand_id is not null`,
  );
  const deleted = await queryRows<{ id: string }>(
    executor,
    sql`delete from pkb_products p
        where p.id = ${pkbProductId}
          and (p.family_assignment_source is null or p.family_assignment_source = 'legacy_category')
          and not exists (select 1 from products l where l.pkb_product_id = p.id)
          and not exists (select 1 from pkb_facts f where f.pkb_product_id = p.id and f.legacy_ref is null)
          and not exists (select 1 from pkb_identifiers i where i.pkb_product_id = p.id and i.legacy_ref is null)
          and not exists (select 1 from pkb_claims c where c.pkb_product_id = p.id)
          and not exists (select 1 from pkb_evidence e where e.pkb_product_id = p.id)
          and not exists (select 1 from pkb_relationships r where r.from_product_id = p.id or r.to_product_id = p.id)
          and not exists (select 1 from pkb_aliases a where a.pkb_product_id = p.id)
        returning p.id`,
  );
  if (deleted.length === 0) return false;
  await executor.execute(sql`
    delete from pkb_sources s
    where s.source_type = 'staff_entry'
      and not exists (select 1 from pkb_facts f where f.source_id = s.id)
      and not exists (select 1 from pkb_identifiers i where i.source_id = s.id)
      and not exists (select 1 from pkb_relationships r where r.source_id = s.id)
      and not exists (select 1 from pkb_evidence e where e.source_id = s.id)
      and not exists (select 1 from pkb_aliases a where a.source_id = s.id)
  `);
  if (brands.length > 0) {
    const { pruneUnusedBrands } = await import("./store");
    await pruneUnusedBrands(executor, brands.map((row) => row.id));
  }
  return true;
}

// ------------------------------------------------------------------ report

export type KnowledgeReport = {
  listings: number;
  listingsWithoutKnowledge: number;
  offers: number;
  offersWithoutKnowledge: number;
  knowledgeProducts: number;
  queued: number;
  factsByState: Record<string, number>;
  factsBySource: Record<string, number>;
  unnormalizedFacts: number;
  identifiers: { total: number; invalid: number };
  verifiedWithoutClaim: number;
  families: { approved: number; suggested: number; productsAssigned: number; productsUnassigned: number };
  unmappedByReason: Record<string, number>;
  brands: { total: number; active: number; trustedSources: number; similarPairs: { a: string; b: string; similarity: number }[] };
  projectionMismatches: { listingId: string; fields: string[] }[];
  ok: boolean;
};

function restrict(fields: LegacyStructuredFields, mapped: Set<string>, parked: Set<string>): LegacyStructuredFields {
  const detailKeys = new Set([...Object.keys(LEGACY_DETAIL_DEFINITIONS), ...Object.keys(LEGACY_DETAIL_IDENTIFIERS)]);
  const details = Object.fromEntries(
    Object.entries(fields.details).filter(([key]) => detailKeys.has(key) && !parked.has(`products.details.${key}`)),
  );
  const attributeValues = Object.fromEntries(
    Object.entries(fields.attributeValues).filter(([key]) => mapped.has(key) && !parked.has(`products.attribute_values.${key}`)),
  );
  const identifierParked = fields.identifierType !== null && parked.has(`products.identifier.${fields.identifierType}`);
  return {
    ...fields,
    details,
    attributeValues,
    identifierType: identifierParked ? null : fields.identifierType,
    identifierValue: identifierParked ? null : fields.identifierValue,
  };
}

function differingFields(a: LegacyStructuredFields, b: LegacyStructuredFields): string[] {
  return (Object.keys(a) as (keyof LegacyStructuredFields)[]).filter(
    (key) => !sameStructuredFields({ ...a, [key]: a[key] }, { ...a, [key]: b[key] }),
  );
}

/**
 * Whether the knowledge base mirrors the listings without loss or invention.
 * `ok` requires: every listing and offer linked, nothing queued, no VERIFIED
 * value without a claim, and every listing's structured legacy fields equal
 * to what the knowledge base would write back — apart from values parked in
 * `pkb_unmapped_values` for a person to place.
 */
export async function knowledgeReport(executor: Executor = db): Promise<KnowledgeReport> {
  const one = async (query: ReturnType<typeof sql>) => Number((await queryRows<{ n: number }>(executor, query))[0]?.n ?? 0);
  const grouped = async (query: ReturnType<typeof sql>) =>
    Object.fromEntries((await queryRows<{ k: string; n: number }>(executor, query)).map((row) => [row.k, Number(row.n)]));

  const report: KnowledgeReport = {
    listings: await one(sql`select count(*)::int as n from products`),
    listingsWithoutKnowledge: await one(sql`select count(*)::int as n from products where pkb_product_id is null`),
    offers: await one(sql`select count(*)::int as n from product_variants`),
    offersWithoutKnowledge: await one(sql`select count(*)::int as n from product_variants where pkb_variant_id is null`),
    knowledgeProducts: await one(sql`select count(*)::int as n from pkb_products`),
    queued: await one(sql`select count(*)::int as n from pkb_sync_queue`),
    factsByState: await grouped(sql`select verification_state as k, count(*)::int as n from pkb_facts group by 1`),
    factsBySource: await grouped(sql`
      select case
               when legacy_ref is null then 'knowledge base'
               when legacy_ref like 'variant_option_values.%' then 'variant options'
               else array_to_string((string_to_array(legacy_ref, '.'))[1:2], '.')
             end as k,
             count(*)::int as n
      from pkb_facts group by 1`),
    unnormalizedFacts: await one(sql`select count(*)::int as n from pkb_facts where value_status = 'unnormalized'`),
    identifiers: {
      total: await one(sql`select count(*)::int as n from pkb_identifiers`),
      invalid: await one(sql`select count(*)::int as n from pkb_identifiers where validation_status = 'invalid'`),
    },
    verifiedWithoutClaim: await one(sql`select count(*)::int as n from pkb_facts where verification_state = 'VERIFIED' and claim_id is null`),
    families: {
      approved: await one(sql`select count(*)::int as n from pkb_families where status = 'approved'`),
      suggested: await one(sql`select count(*)::int as n from pkb_families where status = 'suggested'`),
      productsAssigned: await one(sql`select count(*)::int as n from pkb_products where family_assignment = 'assigned'`),
      productsUnassigned: await one(sql`select count(*)::int as n from pkb_products where family_assignment = 'unassigned'`),
    },
    unmappedByReason: await grouped(sql`select reason as k, count(*)::int as n from pkb_unmapped_values where status = 'open' group by 1`),
    brands: {
      total: await one(sql`select count(*)::int as n from pkb_brands`),
      active: await one(sql`select count(*)::int as n from pkb_brands where status = 'active'`),
      trustedSources: await one(sql`select count(*)::int as n from pkb_source_registry where status = 'approved' and role <> 'blocked'`),
      // Reported for a person to judge (A-2); never merged here.
      similarPairs: (
        await queryRows<{ a: string; b: string; similarity: number }>(
          executor,
          sql`select a.name as a, b.name as b, round(similarity(a.name_normalized, b.name_normalized)::numeric, 2)::float as similarity
              from pkb_brands a join pkb_brands b on a.id < b.id
              where similarity(a.name_normalized, b.name_normalized) >= 0.6
              order by 3 desc limit 50`,
        )
      ).map((row) => ({ ...row, similarity: Number(row.similarity) })),
    },
    projectionMismatches: [],
    ok: false,
  };

  const mapped = new Set(
    (await queryRows<{ id: string }>(executor, sql`select category_attribute_id::text as id from pkb_legacy_attribute_map`)).map((row) => row.id),
  );
  const parkedRows = await queryRows<{ product_id: string; legacy_ref: string }>(
    executor,
    sql`select product_id, legacy_ref from pkb_unmapped_values`,
  );
  const parkedBy = new Map<string, Set<string>>();
  for (const row of parkedRows) {
    parkedBy.set(row.product_id, (parkedBy.get(row.product_id) ?? new Set()).add(row.legacy_ref));
  }

  /*
   * The comparison walks the catalogue in chunks, and each chunk loads its
   * knowledge in two statements rather than two per listing (risk R-2). On the
   * 5,000-listing scale database that is 10,024 statements down to about 40,
   * and the peak memory is one chunk of listings rather than all of them.
   */
  const RECONCILE_CHUNK = 500;
  for (let offset = 0; ; offset += RECONCILE_CHUNK) {
    const listings: (typeof products.$inferSelect)[] = await executor
      .select()
      .from(products)
      .orderBy(products.id)
      .limit(RECONCILE_CHUNK)
      .offset(offset);
    if (listings.length === 0) break;

    const withKnowledge = listings.filter((listing) => listing.pkbProductId !== null);
    const projections = await loadProjections(
      executor,
      withKnowledge.map((listing) => listing.pkbProductId!),
    );

    for (const listing of withKnowledge) {
      const parked = parkedBy.get(listing.id) ?? new Set<string>();
      const legacy = restrict(legacyStructuredFields(listing), mapped, parked);
      const projected = restrict(
        // A knowledge product with no mirrored value at all projects to nothing,
        // which is exactly what the batch loader returns for it.
        projections.get(listing.pkbProductId!)!,
        mapped,
        parked,
      );
      if (!sameStructuredFields(legacy, projected)) {
        report.projectionMismatches.push({ listingId: listing.id, fields: differingFields(legacy, projected) });
      }
    }
    if (listings.length < RECONCILE_CHUNK) break;
  }

  report.ok =
    report.listingsWithoutKnowledge === 0 &&
    report.offersWithoutKnowledge === 0 &&
    report.queued === 0 &&
    report.verifiedWithoutClaim === 0 &&
    report.projectionMismatches.length === 0;
  return report;
}
