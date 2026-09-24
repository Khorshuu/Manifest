import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { PkbError, queryRows, type Executor } from "./common";
import { suggestAlias } from "./aliases";
import { contextForLegacyRef, loadLabelMappings, resolveLabel } from "./mappings";
import { labelKey } from "./normalize";
import { loadDefinitions } from "./vocabulary";

/**
 * What still depends on the legacy catalogue tables, counted (D-105).
 *
 * The migration strategy (D-069) ends in a *contract* step: once a legacy
 * column or table has no reader and the knowledge base holds everything it
 * held, it is removed. Stage 7 is where that was meant to happen, and the
 * honest answer turned out to be "not yet for most of it" — so this report
 * exists to make that a measurement rather than an opinion, and to be the
 * evidence a later contraction is allowed to rely on.
 *
 * Every figure is counted from the database. Nothing here is derived, cached,
 * or projected forward, and nothing is written: it is a read that says how far
 * the migration has actually got.
 *
 * The rule it serves: **a legacy system is contracted when its coverage is
 * complete and no reader remains — never because a plan said it would be.**
 */

export type LegacySystemCoverage = {
  /** What the legacy system is, in the words an operator would use. */
  system: string;
  /** Rows, values or listings that still live in it. */
  total: number;
  /** Of those, how many the knowledge base already holds. */
  covered: number;
  /** What is in the way, when anything is. */
  blocking: string | null;
  /** Whether this one could be contracted on this database today. */
  contractable: boolean;
};

export type LegacyCoverage = {
  systems: LegacySystemCoverage[];
  /** Values a person has been asked about and has not yet placed (A-8). */
  parkedValues: number;
  /** True only when every system above is contractable. */
  allCovered: boolean;
};

type RecordedTerm = { pkbProductId: string; term: string };

/** Every search term recorded on a listing that has a knowledge record. */
async function recordedTerms(executor: Executor): Promise<RecordedTerm[]> {
  const rows = await queryRows<{ pkb_product_id: string; term: string }>(
    executor,
    sql`
      select p.pkb_product_id, jsonb_array_elements_text(p.search_keywords) as term
      from products p
      where p.pkb_product_id is not null
        and p.search_keywords is not null
        and jsonb_typeof(p.search_keywords) = 'array'
    `,
  );
  return rows.map((row) => ({ pkbProductId: row.pkb_product_id, term: row.term }));
}

/** How many recorded search terms are already an alias, by decision. */
async function keywordAliasCoverage(executor: Executor) {
  const terms = await recordedTerms(executor);
  if (terms.length === 0) return { listings: 0, terms: 0, suggested: 0, approved: 0 };

  const aliases = await queryRows<{ pkb_product_id: string; alias_normalized: string; status: string }>(
    executor,
    sql`
      select pkb_product_id, alias_normalized, status
      from pkb_aliases
      where target_kind = 'product' and pkb_product_id is not null
    `,
  );
  const byProduct = new Map<string, Map<string, string>>();
  for (const alias of aliases) {
    const forProduct = byProduct.get(alias.pkb_product_id) ?? new Map<string, string>();
    // An approved decision wins over a suggestion for the same wording.
    if (forProduct.get(alias.alias_normalized) !== "approved") {
      forProduct.set(alias.alias_normalized, alias.status);
    }
    byProduct.set(alias.pkb_product_id, forProduct);
  }

  let suggested = 0;
  let approved = 0;
  for (const { pkbProductId, term } of terms) {
    const status = byProduct.get(pkbProductId)?.get(labelKey(term));
    if (status === "approved") approved += 1;
    else if (status === "suggested") suggested += 1;
  }

  return {
    listings: new Set(terms.map((row) => row.pkbProductId)).size,
    terms: terms.length,
    suggested,
    approved,
  };
}

export async function legacyCoverage(
  actor: SessionUser | null,
  executor: Executor = db,
): Promise<LegacyCoverage> {
  requirePermission(actor, "catalog.manage");

  const row = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T> =>
    (await queryRows<T>(executor, query))[0];

  const specifications = await row<{ total: number; mapped: number }>(sql`
    select count(*)::int as total,
           count(*) filter (
             where exists (select 1 from pkb_legacy_attribute_map m where m.category_attribute_id = ca.id)
           )::int as mapped
    from category_attributes ca
  `);

  const options = await row<{ total: number; matched: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where a.attribute_definition_id is not null)::int as matched
    from attributes a
  `);

  // A variant's option selection is mirrored as one fact on the offer, keyed
  // by the *option group* — `variant_option_values.<attribute id>` — so the
  // coverage question is per selection, not per row of the shared value list.
  const values = await row<{ total: number; mirrored: number }>(sql`
    select count(*)::int as total,
           count(*) filter (
             where exists (
               select 1 from pkb_facts f
               where f.pkb_variant_id = pv.pkb_variant_id
                 and f.legacy_ref = 'variant_option_values.' || av.attribute_id::text
             )
           )::int as mirrored
    from variant_option_values vov
    join attribute_values av on av.id = vov.attribute_value_id
    join product_variants pv on pv.id = vov.variant_id
    where pv.pkb_variant_id is not null
  `);

  // Matched in TypeScript rather than SQL. `alias_normalized` is written by
  // `labelKey`, which folds accents and joins on spaces; the database's
  // `search_term_key` deliberately does neither. Re-implementing one in the
  // other's language is how the two quietly stop agreeing, so the comparison
  // uses the function that wrote the value. The volumes make this free: a
  // listing may carry at most forty search terms.
  const keywords = await keywordAliasCoverage(executor);

  const parked = await row<{ n: number }>(sql`select count(*)::int as n from pkb_unmapped_values`);

  const systems: LegacySystemCoverage[] = [
    {
      system: "Shelf specification definitions (category_attributes)",
      total: specifications.total,
      covered: specifications.mapped,
      blocking:
        specifications.total === specifications.mapped
          ? null
          : `${specifications.total - specifications.mapped} definition(s) have no knowledge attribute.`,
      contractable: specifications.total === specifications.mapped,
    },
    {
      system: "Variant option groups (attributes)",
      total: options.total,
      covered: options.matched,
      blocking:
        options.total === options.matched
          ? null
          : `${options.total - options.matched} option group(s) are not matched to a knowledge attribute.`,
      contractable: options.total === options.matched,
    },
    {
      system: "Variant option selections (variant_option_values)",
      total: values.total,
      covered: values.mirrored,
      blocking:
        values.total === values.mirrored
          ? null
          : `${values.total - values.mirrored} selection(s) are not mirrored as facts.`,
      contractable: values.total === values.mirrored,
    },
    {
      system: "Listing search terms (products.search_keywords)",
      total: keywords.terms,
      covered: keywords.approved,
      // Retained on purpose, so this one is never "contractable": see D-105.
      blocking:
        `Retained. A search term is a listing's marketing hint, not a fact about the product; it becomes knowledge only when somebody suggests it as an alias and somebody else approves it. ` +
        `${keywords.approved} of ${keywords.terms} term(s) are already approved aliases, ${keywords.suggested} are waiting for a decision.`,
      contractable: false,
    },
  ];

  return {
    systems,
    parkedValues: Number(parked?.n ?? 0),
    allCovered: systems.every((system) => system.contractable),
  };
}

// --------------------------------------------------- the parked values, sorted

/**
 * What each parked value is, decided from the database (Stage 8, D-109).
 *
 * `pkb_unmapped_values` is where a legacy value goes when the pipeline will not
 * guess where it belongs (A-8). The coverage report above counts them; this one
 * says what they *are*, because "72 values parked" is not something a person can
 * act on and a bare count invites the wrong action — either discarding them or
 * placing them by hand in the database.
 *
 * Five classes, in the order they are decided. Nothing here writes, nothing
 * infers meaning, and a row is only ever called migratable when the knowledge
 * base already holds an attribute that answers to its label:
 *
 *  - `unusable` — not a value anything could hold: an identifier that failed
 *    its check digit (kept as supplied and never corrected, D-071/R-6), or an
 *    empty value.
 *  - `obsolete` — the listing behind it is archived, or has no knowledge record
 *    any more. Kept for history; there is nothing to migrate into.
 *  - `already_represented` — an approved attribute answers to this label *and*
 *    the slot it would fill already holds a value. The parked row is a
 *    duplicate of what is stored.
 *  - `migratable` — an approved attribute answers to this label, by its own
 *    label, its key or an approved alias, or an approved mapping already covers
 *    it, and the slot is empty. Approving the mapping on the knowledge screen
 *    places it through the normal pipeline with its provenance intact; no value
 *    is edited in place.
 *  - `ambiguous` — no approved attribute answers to this label, or more than
 *    one does. It needs a person to say what it means. This is the honest
 *    remainder, and it is the reason `category_attributes` is still here.
 */
export const PARKED_CLASSES = ["migratable", "already_represented", "ambiguous", "obsolete", "unusable"] as const;

export type ParkedClass = (typeof PARKED_CLASSES)[number];

export type ParkedValueGroup = {
  parkedClass: ParkedClass;
  /** The written label, or the identifier type for an identifier row. */
  label: string;
  /** Where it was written: `products.spec_table`, `variant_option_values.<id>`, … */
  legacyRef: string;
  /** Why the pipeline parked it. */
  reason: string;
  /** The attribute this label already means, when one does. */
  definition: { id: string; label: string } | null;
  rows: number;
  listings: number;
  samples: { title: string; value: string }[];
};

export type ParkedValueReport = {
  total: number;
  counts: Record<ParkedClass, number>;
  groups: ParkedValueGroup[];
  /** Values that need a person before anything can be contracted. */
  needingDecision: number;
};

type ParkedRow = {
  product_id: string;
  variant_id: string | null;
  pkb_product_id: string | null;
  pkb_variant_id: string | null;
  archived: boolean;
  title: string;
  label: string | null;
  value: string;
  reason: string;
  legacy_ref: string;
  family_id: string | null;
};

export async function classifyParkedValues(
  actor: SessionUser | null,
  executor: Executor = db,
): Promise<ParkedValueReport> {
  requirePermission(actor, "catalog.manage");

  const rows = await queryRows<ParkedRow>(
    executor,
    sql`
      select u.product_id, u.variant_id, p.pkb_product_id, pv.pkb_variant_id,
             (p.archived_at is not null) as archived,
             p.title, u.label, u.value, u.reason, u.legacy_ref, kp.family_id
      from pkb_unmapped_values u
      join products p on p.id = u.product_id
      left join product_variants pv on pv.id = u.variant_id
      left join pkb_products kp on kp.id = p.pkb_product_id
      where u.status = 'open'
      order by u.legacy_ref, u.label nulls first, p.title
    `,
  );

  const definitions = await loadDefinitions(executor);
  const mappings = await loadLabelMappings(executor);

  // Which (product or variant, definition) slots already hold a value, so a
  // parked row can be told from a duplicate of something already stored.
  const filled = new Set<string>();
  if (rows.length > 0) {
    const factRows = await queryRows<{ pkb_product_id: string; pkb_variant_id: string | null; definition_id: string }>(
      executor,
      sql`
        select pkb_product_id, pkb_variant_id, definition_id
        from pkb_facts
        where pkb_product_id = any(${`{${[...new Set(rows.map((row) => row.pkb_product_id).filter(Boolean))].join(",")}}`}::uuid[])
      `,
    );
    for (const fact of factRows) {
      filled.add(`${fact.pkb_product_id}|${fact.pkb_variant_id ?? ""}|${fact.definition_id}`);
    }
  }

  const groups = new Map<string, ParkedValueGroup>();
  const counts: Record<ParkedClass, number> = {
    migratable: 0,
    already_represented: 0,
    ambiguous: 0,
    obsolete: 0,
    unusable: 0,
  };

  for (const row of rows) {
    const label = row.label ?? "";
    let definition: { id: string; label: string } | null = null;
    let parkedClass: ParkedClass;

    if (row.reason === "invalid_identifier" || !row.value.trim() || !label.trim()) {
      parkedClass = "unusable";
    } else if (row.archived || !row.pkb_product_id) {
      parkedClass = "obsolete";
    } else {
      const context = contextForLegacyRef(row.legacy_ref);
      const resolution = context
        ? resolveLabel(definitions, mappings, label, context, row.family_id)
        : { kind: "none" as const };
      if (resolution.kind === "match") {
        definition = { id: resolution.definition.id, label: resolution.definition.label };
        const slot = `${row.pkb_product_id}|${row.pkb_variant_id ?? ""}|${resolution.definition.id}`;
        parkedClass = filled.has(slot) ? "already_represented" : "migratable";
      } else {
        // `ignored` cannot appear here: a row covered by an ignore decision is
        // settled by the sync rather than left open.
        parkedClass = "ambiguous";
      }
    }

    counts[parkedClass] += 1;
    const key = `${parkedClass}|${row.legacy_ref}|${labelKey(label)}`;
    const group = groups.get(key) ?? {
      parkedClass,
      label: label || row.reason,
      legacyRef: row.legacy_ref,
      reason: row.reason,
      definition,
      rows: 0,
      listings: 0,
      samples: [],
    };
    group.rows += 1;
    if (group.samples.length < 3) group.samples.push({ title: row.title, value: row.value });
    groups.set(key, group);
  }

  // Listings per group, counted separately so one listing with three parked
  // rows is one listing.
  const listingsPerGroup = new Map<string, Set<string>>();
  for (const row of rows) {
    const label = row.label ?? "";
    for (const [key, group] of groups) {
      if (group.legacyRef === row.legacy_ref && key.endsWith(`|${labelKey(label)}`)) {
        const seen = listingsPerGroup.get(key) ?? new Set<string>();
        seen.add(row.product_id);
        listingsPerGroup.set(key, seen);
      }
    }
  }
  for (const [key, group] of groups) group.listings = listingsPerGroup.get(key)?.size ?? 0;

  const order = new Map(PARKED_CLASSES.map((name, index) => [name, index]));
  return {
    total: rows.length,
    counts,
    groups: [...groups.values()].sort(
      (a, b) => (order.get(a.parkedClass)! - order.get(b.parkedClass)!) || b.rows - a.rows || a.label.localeCompare(b.label),
    ),
    needingDecision: counts.ambiguous + counts.migratable,
  };
}

/**
 * Offers a listing's recorded search terms as *suggested* product aliases
 * (D-105).
 *
 * This is the migration path for the one piece of legacy search knowledge that
 * has somewhere to go, and the point is what it does **not** do. It does not
 * convert a search term into vocabulary: every term it writes lands as
 * `suggested`, attributed to the person who asked for it, and somebody holding
 * `search.manage` still has to approve each one (D-094). A term nobody approves
 * stays exactly what it was — a search term on a listing — and is not lost.
 *
 * Nothing is deleted either. `products.search_keywords` keeps its values
 * whatever happens here, because a marketing hint that failed to become an
 * alias is still a marketing hint.
 *
 * Idempotent: a term that already has an alias of any status is skipped, so
 * running it twice proposes nothing new and a rejected term is not re-proposed.
 */
export async function suggestAliasesFromKeywords(
  actor: SessionUser | null,
  listingId: string,
): Promise<{ proposed: string[]; skipped: string[] }> {
  requirePermission(actor, "catalog.manage");

  const [listing] = await queryRows<{ pkb_product_id: string | null }>(
    db,
    sql`select pkb_product_id from products where id = ${listingId}`,
  );
  if (!listing) throw new PkbError("That listing does not exist.", 404);
  if (!listing.pkb_product_id) {
    throw new PkbError("That listing has no knowledge record yet, so it has nothing to be an alias of.", 409);
  }

  const migration = await listingKeywordMigration(actor, listingId);
  const proposed: string[] = [];
  const skipped: string[] = [];

  for (const { term, status } of migration.terms) {
    if (status !== "unknown") {
      skipped.push(term);
      continue;
    }
    try {
      await suggestAlias(actor, {
        target: { kind: "product", id: listing.pkb_product_id },
        alias: term,
        aliasKind: "other",
        evidenceNote: "Recorded as a search term on this listing before the knowledge base held aliases.",
      });
      proposed.push(term);
    } catch (error) {
      // An alias somebody has already decided on, or a term with no letters or
      // digits in it. Neither is a reason to abandon the rest.
      if (error instanceof PkbError) skipped.push(term);
      else throw error;
    }
  }

  return { proposed, skipped };
}

/** How many of a listing's recorded search terms are already aliases. */
export type KeywordMigration = {
  listingId: string;
  /** Terms recorded on the listing, in the order they were written. */
  terms: { term: string; status: "approved" | "suggested" | "unknown" }[];
};

export async function listingKeywordMigration(
  actor: SessionUser | null,
  listingId: string,
  executor: Executor = db,
): Promise<KeywordMigration> {
  requirePermission(actor, "catalog.manage");

  const [listing] = await queryRows<{ pkb_product_id: string | null; search_keywords: unknown }>(
    executor,
    sql`select pkb_product_id, search_keywords from products where id = ${listingId}`,
  );
  const recorded = Array.isArray(listing?.search_keywords)
    ? (listing.search_keywords as unknown[]).filter((term): term is string => typeof term === "string")
    : [];
  if (recorded.length === 0 || !listing?.pkb_product_id) return { listingId, terms: [] };

  const aliases = await queryRows<{ alias_normalized: string; status: string }>(
    executor,
    sql`
      select alias_normalized, status from pkb_aliases
      where target_kind = 'product' and pkb_product_id = ${listing.pkb_product_id}
    `,
  );
  const decided = new Map<string, string>();
  for (const alias of aliases) {
    if (decided.get(alias.alias_normalized) !== "approved") decided.set(alias.alias_normalized, alias.status);
  }

  return {
    listingId,
    terms: recorded.map((term) => {
      const status = decided.get(labelKey(term));
      return {
        term,
        status: status === "approved" ? ("approved" as const) : status === "suggested" ? ("suggested" as const) : ("unknown" as const),
      };
    }),
  };
}
