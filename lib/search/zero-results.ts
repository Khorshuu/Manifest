import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { countProducts } from "@/lib/catalog/storefront";
import { closestWord, planSearch } from "./plan";
import { isPublicAs, queryRows } from "./sql";
import { termKey } from "./terms";

/**
 * Why a search found nothing, and what could be done about it (D-094).
 *
 * A zero-result list on its own tells staff that something went wrong and
 * nothing about what. The seven verdicts below are different problems with
 * different fixes: a misspelling is a search problem, a missing alias is a
 * vocabulary problem, an attribute nothing satisfies is a buying decision, and
 * a query about something the shop does not sell is not a problem at all.
 *
 * Everything here is read-only and deterministic. It proposes; it never
 * writes. In particular a customer's words never become search vocabulary on
 * their own: an alias recommendation is a suggestion on a screen, which a
 * person turns into a *suggested* alias, which someone with `search.manage`
 * then has to approve (D-067). Two deliberate human steps, because an alias
 * taken from whatever someone typed would let anyone who searches enough teach
 * the shop that their word means one of its products.
 */

export const ZERO_RESULT_VERDICTS = [
  "typo",
  "missing_alias",
  "attribute_mismatch",
  "unavailable_product",
  "missing_category",
  "missing_product",
  "irrelevant",
] as const;
export type ZeroResultVerdict = (typeof ZERO_RESULT_VERDICTS)[number];

export type AliasRecommendation = {
  /** What was typed, as it would be stored. */
  alias: string;
  target: { kind: "brand" | "product" | "family"; id: string; name: string };
  /** How close the two are, 0 to 1 — shown so a person can judge it. */
  similarity: number;
};

export type ZeroResultFinding = {
  query: string;
  searches: number;
  visitors: number;
  lastSearchedAt: Date;
  verdict: ZeroResultVerdict;
  /** One sentence a person can act on. */
  explanation: string;
  /** What to do, in words. Never done automatically. */
  recommendation: string;
  /** The spelling the catalogue uses, when the verdict is a typo. */
  correction: string | null;
  /** Vocabulary this could be added to — a suggestion, never applied. */
  aliasCandidates: AliasRecommendation[];
  /** Listings that would answer it but are not visible. */
  hiddenMatches: { id: string; title: string; reason: string }[];
  /** Parts of the search that do find something on their own. */
  workingParts: { query: string; count: number }[];
};

/** How alike two names must read before a person is asked to consider them. */
const ALIAS_SIMILARITY = 0.45;

/** Entities the query is close to, by trigram similarity over their names. */
async function aliasCandidatesFor(query: string): Promise<AliasRecommendation[]> {
  const key = termKey(query);
  if (key.length < 3) return [];
  const spaced = key.replace(/_/g, " ");

  const rows = await queryRows<{
    kind: "brand" | "product" | "family";
    id: string;
    name: string;
    similarity: number;
  }>(sql`
    select kind, id, name, similarity(compare, ${spaced})::float8 as similarity
    from (
      select 'brand'::text as kind, b.id::text as id, b.name as name,
             replace(search_term_key(b.name), '_', ' ') as compare
      from pkb_brands b
      where b.status = 'active'
      union all
      select 'family', f.id::text, f.name,
             replace(search_term_key(f.name), '_', ' ')
      from pkb_families f
      where f.status = 'approved'
      union all
      -- Only products a shopper could actually be shown.
      select 'product', k.id::text, k.name,
             replace(search_term_key(k.name), '_', ' ')
      from pkb_products k
      join products p on p.pkb_product_id = k.id
      where k.status = 'active' and ${isPublicAs("p")}
    ) as entity
    where similarity(compare, ${spaced}) >= ${ALIAS_SIMILARITY}
      -- Something already answering to this name needs no alias.
      and not exists (
        select 1 from pkb_aliases a
        where a.status = 'approved' and search_term_key(a.alias) = ${key}
      )
    order by similarity desc, name
    limit 3
  `);

  return rows.map((row) => ({
    alias: query,
    target: { kind: row.kind, id: row.id, name: row.name },
    similarity: Number(row.similarity),
  }));
}

/** Listings that answer the search but that a shopper cannot be shown. */
async function hiddenMatchesFor(
  query: string,
): Promise<{ id: string; title: string; reason: string }[]> {
  const plan = await planSearch(query);
  if (!plan?.tsquery) return [];

  return queryRows<{ id: string; title: string; reason: string }>(sql`
    select p.id::text as id, p.title,
      case
        when p.archived_at is not null then 'archived'
        when not p.searchable then 'hidden from search'
        else p.status
      end as reason
    from products p
    join product_search ps on ps.product_id = p.id
    where ps.document @@ to_tsquery('english', ${plan.tsquery})
      and not (${isPublicAs("p")})
    order by p.title
    limit 3
  `);
}

/**
 * Which part of a multi-part search is impossible.
 *
 * Runs the search again without each position in turn. If leaving one out
 * finds products, that position is the one nothing satisfies — which is a
 * buying question ("nobody stocks a black one"), not a search fault.
 */
async function impossiblePart(query: string): Promise<{
  dropped: string;
  remaining: string;
  count: number;
} | null> {
  const plan = await planSearch(query);
  if (!plan || plan.slots.length < 2) return null;

  for (let index = 0; index < plan.slots.length; index++) {
    const kept = plan.slots
      .filter((_, position) => position !== index)
      .flatMap((slot) => slot.typed)
      .join(" ");
    if (!kept) continue;

    const reduced = await planSearch(kept);
    if (!reduced) continue;
    const count = await countProducts({ plan: reduced });
    if (count > 0) {
      return {
        dropped: plan.slots[index].typed.join(" "),
        remaining: kept,
        count,
      };
    }
  }
  return null;
}

/** What each word of the search finds on its own. */
async function workingParts(
  query: string,
): Promise<{ query: string; count: number }[]> {
  const plan = await planSearch(query);
  if (!plan || plan.words.length < 2) return [];

  const found = await Promise.all(
    plan.words.slice(0, 4).map(async (word) => {
      const single = await planSearch(word);
      if (!single) return null;
      const count = await countProducts({ plan: single });
      return count > 0 ? { query: word, count } : null;
    }),
  );
  return found.filter((entry): entry is { query: string; count: number } => entry !== null);
}

/** A family or category the search names that has nothing public in it. */
async function namesAnEmptyShelf(query: string): Promise<string | null> {
  const key = termKey(query);
  if (!key) return null;

  const rows = await queryRows<{ name: string }>(sql`
    select f.name
    from pkb_families f
    where f.status = 'approved'
      and (search_term_key(f.name) = ${key} or search_term_key(f.key) = ${key})
      and not exists (
        select 1 from products p
        join pkb_products k on k.id = p.pkb_product_id and k.family_id = f.id
        where ${isPublicAs("p")}
      )
    union all
    select c.name
    from categories c
    where search_term_key(c.name) = ${key}
      and not exists (
        select 1 from products p where p.category_id = c.id and ${isPublicAs("p")}
      )
    limit 1
  `);

  return rows[0]?.name ?? null;
}

async function classify(entry: {
  query: string;
  searches: number;
  visitors: number;
  lastSearchedAt: Date;
}): Promise<ZeroResultFinding> {
  const base = { ...entry, correction: null as string | null, aliasCandidates: [] as AliasRecommendation[], hiddenMatches: [] as { id: string; title: string; reason: string }[], workingParts: [] as { query: string; count: number }[] };

  // 1. A misspelling the catalogue's own vocabulary can correct.
  const plan = await planSearch(entry.query);
  if (plan) {
    for (const word of plan.words) {
      if (word.length < 3) continue;
      const closest = await closestWord(word);
      if (closest && closest.word !== word) {
        const corrected = plan.words
          .map((candidate) => (candidate === word ? closest.display : candidate))
          .join(" ");
        const correctedPlan = await planSearch(corrected);
        if (correctedPlan && (await countProducts({ plan: correctedPlan })) > 0) {
          return {
            ...base,
            verdict: "typo",
            correction: corrected,
            explanation: `“${word}” is not a word the catalogue uses; “${closest.display}” is.`,
            recommendation:
              "The search already corrects itself. Record the misspelling as an alias only if it keeps coming back.",
            aliasCandidates: await aliasCandidatesFor(entry.query),
          };
        }
      }
    }
  }

  // 2. Something answers it, but nobody can see it.
  const hidden = await hiddenMatchesFor(entry.query);
  if (hidden.length > 0) {
    return {
      ...base,
      verdict: "unavailable_product",
      hiddenMatches: hidden,
      explanation: `${hidden.length === 1 ? "A listing answers" : `${hidden.length} listings answer`} this search, but ${hidden.length === 1 ? "it is" : "they are"} not visible (${[...new Set(hidden.map((row) => row.reason))].join(", ")}).`,
      recommendation:
        "Publish it, or make it searchable again, if it is meant to be on sale.",
    };
  }

  // 3. A name the shop nearly uses — which is what an alias is for.
  const candidates = await aliasCandidatesFor(entry.query);
  if (candidates.length > 0) {
    const best = candidates[0];
    return {
      ...base,
      verdict: "missing_alias",
      aliasCandidates: candidates,
      explanation: `Close to ${best.target.name}, which the catalogue does carry.`,
      recommendation: `Consider recording “${entry.query}” as an alias of ${best.target.name}. It has to be approved before it changes any search.`,
    };
  }

  // 4. A combination nothing satisfies, with the part that makes it impossible.
  const impossible = await impossiblePart(entry.query);
  if (impossible) {
    return {
      ...base,
      verdict: "attribute_mismatch",
      workingParts: [{ query: impossible.remaining, count: impossible.count }],
      explanation: `“${impossible.remaining}” finds ${impossible.count}, but nothing also matches “${impossible.dropped}”.`,
      recommendation:
        "Nothing in the catalogue has that combination. This is a buying decision, not a search fault.",
    };
  }

  // 5. A shelf or family that exists with nothing public in it.
  const emptyShelf = await namesAnEmptyShelf(entry.query);
  if (emptyShelf) {
    return {
      ...base,
      verdict: "missing_category",
      explanation: `${emptyShelf} exists but has nothing published in it.`,
      recommendation: "Publish something there, or take the shelf down.",
    };
  }

  // 6. Its words are catalogue words; the thing itself is not stocked.
  const parts = await workingParts(entry.query);
  if (parts.length > 0) {
    return {
      ...base,
      verdict: "missing_product",
      workingParts: parts,
      explanation: `Its words are ones the catalogue uses (${parts.map((part) => `“${part.query}” finds ${part.count}`).join(", ")}), but nothing answers all of them.`,
      recommendation: "A product the shop does not sell yet. Worth knowing what people ask for.",
    };
  }

  // 7. Nothing at all.
  return {
    ...base,
    verdict: "irrelevant",
    explanation: "Nothing in the catalogue is related to this.",
    recommendation: "Nothing to do.",
  };
}

/**
 * The zero-result searches of the last `days`, each with a verdict.
 *
 * Staff only, and deliberately capped: this runs several indexed lookups per
 * query, which is fine for the twenty that matter and would not be for
 * thousands.
 */
export async function zeroResultIntelligence(
  actor: SessionUser | null,
  options: { days?: number; limit?: number } = {},
): Promise<ZeroResultFinding[]> {
  requirePermission(actor, "search.manage");

  const days = options.days ?? 30;
  const limit = Math.min(options.limit ?? 20, 50);

  const rows = await queryRows<{
    query: string;
    searches: number;
    visitors: number;
    last_searched_at: Date;
  }>(sql`
    select
      (array_agg(q.query order by q.created_at desc))[1] as query,
      count(*)::int as searches,
      count(distinct q.visitor_hash)::int as visitors,
      max(q.created_at) as last_searched_at
    from search_queries q
    where q.created_at > now() - make_interval(days => ${days})
      and q.results_count = 0
    group by q.query_norm
    order by count(*) desc, max(q.created_at) desc
    limit ${limit}
  `);

  const findings: ZeroResultFinding[] = [];
  for (const row of rows) {
    findings.push(
      await classify({
        query: row.query,
        searches: Number(row.searches),
        visitors: Number(row.visitors),
        lastSearchedAt: new Date(row.last_searched_at),
      }),
    );
  }
  return findings;
}

/**
 * The queries themselves, with nothing derived — for a caller that wants the
 * list without paying for the verdicts.
 */
export async function zeroResultQueries(
  actor: SessionUser | null,
  days = 30,
): Promise<{ query: string; searches: number }[]> {
  requirePermission(actor, "search.manage");
  const rows = await db.execute(sql`
    select (array_agg(q.query order by q.created_at desc))[1] as query,
           count(*)::int as searches
    from search_queries q
    where q.created_at > now() - make_interval(days => ${days})
      and q.results_count = 0
    group by q.query_norm
    order by count(*) desc
    limit 50
  `);
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
    query: string;
    searches: number;
  }[];
  return list.map((row) => ({ query: row.query, searches: Number(row.searches) }));
}

