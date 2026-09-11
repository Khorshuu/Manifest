import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { categories, products } from "@/db/schema";
import { loadCardAggregates } from "@/lib/catalog/card-data";
import { publicProductWhere } from "@/lib/catalog/facets";
import { popularSearches, trendingSearches } from "./analytics";
import { cleanQuery } from "./normalize";
import { correctSearch, planSearch } from "./plan";
import {
  isPublicAs,
  queryRows,
  relevanceAdjustment,
  relevanceTier,
  searchMatch,
  type SearchPlan,
} from "./sql";

/**
 * Suggestions under the header search, as someone types.
 *
 * Four kinds, each an answer to a different question:
 *
 *  - searches worth running, completed from what the catalogue actually
 *    says — the names of the products that match, the tags staff filed them
 *    under, and searches enough other people ran that found something;
 *  - the products themselves, a few of them, with a photograph and the price
 *    a shopper would pay today;
 *  - the categories those products sit in ("iphone in Phones"), and
 *    categories whose own name matches;
 *  - brands.
 *
 * Nothing is invented. A suggested search is always one that leads to
 * results, which is why every source here goes through the public predicate.
 * A draft, an archived product, or a product hidden from search cannot
 * surface — not as a product, not through its words, not through its tags.
 *
 * Cost per keystroke is a handful of indexed queries over a candidate set of
 * forty. The box debounces, cancels superseded requests, and the response is
 * cached briefly by the browser.
 */

export type Suggestion = {
  kind: "product" | "brand" | "category" | "search";
  label: string;
  href: string;
  /** Products carry their photograph; nothing else does. */
  thumbnailUrl?: string | null;
  /** A second line — a product's brand, a category's kind. */
  hint?: string | null;
  /** Products: what a shopper would pay now, in paisa. */
  priceBdt?: number | null;
  /** Category scopes: the search this narrows ("iphone" in "Phones"). */
  scope?: string | null;
};

export type SuggestResult = {
  suggestions: Suggestion[];
  /** Set when nothing matched as typed and the suggestions follow a correction. */
  correctedQuery: string | null;
};

const CANDIDATES = 40;
const MAX_COMPLETIONS = 6;
const MAX_PRODUCTS = 4;

const searchHref = (query: string, category?: string) => {
  const params = new URLSearchParams({ q: query });
  if (category) params.set("category", category);
  return `/search?${params.toString()}`;
};

/** The best-matching public products, best first. */
async function candidates(plan: SearchPlan) {
  return db
    .select({
      id: products.id,
      title: products.title,
      slug: products.slug,
      brand: products.brand,
      categoryName: categories.name,
      categorySlug: categories.slug,
    })
    .from(products)
    .innerJoin(sql`product_search ps`, sql`ps.product_id = ${products.id}`)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(and(publicProductWhere, searchMatch(plan)))
    .orderBy(
      sql`${relevanceTier(plan)} desc`,
      sql`${relevanceAdjustment(plan)} desc`,
      asc(products.title),
    )
    .limit(CANDIDATES);
}

/** A name up to its first comma, bracket or dash — the part worth completing. */
const CORE_SPLIT = /\s[-–—|]\s|[,([]/;

function tokens(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Searches a product name suggests, given what has been typed: the typed words
 * where they occur in the name, completed and extended by up to two more words
 * ("iph" → "iPhone", "iPhone 15", "iPhone 15 Pro"), plus the typed words
 * followed by what the product is when the name says it is *for* them
 * ("Silicone Case for iPhone" → "iPhone Case"). Spelled as the name spells it.
 */
function phrasesFrom(plan: SearchPlan, title: string): string[] {
  const words = tokens(title.split(CORE_SPLIT)[0] ?? title);
  const lower = words.map((word) => word.toLowerCase());
  const typed = plan.words;
  const phrases: string[] = [];

  for (let start = 0; start < lower.length; start++) {
    const matches = typed.every((word, offset) => {
      const token = lower[start + offset];
      return token !== undefined && token.startsWith(word);
    });
    if (!matches) continue;

    for (let extra = 0; extra <= 2; extra++) {
      const end = start + typed.length + extra;
      if (end > words.length) break;
      phrases.push(words.slice(start, end).join(" "));
    }

    if (start >= 2 && lower[start - 1] === "for") {
      phrases.push(
        `${words.slice(start, start + typed.length).join(" ")} ${words[start - 2]}`,
      );
    }
    break;
  }

  return phrases;
}

function completionsFrom(
  plan: SearchPlan,
  titles: string[],
): string[] {
  const scored = new Map<string, { label: string; score: number }>();

  titles.forEach((title, index) => {
    // The best matches count for more than the fortieth.
    const weight = 1 + (titles.length - index) / titles.length;
    for (const phrase of phrasesFrom(plan, title)) {
      const key = phrase.toLowerCase();
      if (key === plan.normalized) continue;
      const entry = scored.get(key) ?? { label: phrase, score: 0 };
      entry.score += weight;
      scored.set(key, entry);
    }
  });

  return [...scored.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.label.split(" ").length - b.label.split(" ").length ||
        a.label.localeCompare(b.label),
    )
    .map((entry) => entry.label);
}

/** Tags staff filed public products under that start with what was typed. */
async function tagCompletions(plan: SearchPlan): Promise<string[]> {
  const rows = await queryRows<{ tag: string }>(sql`
    select min(tag.value) as tag
    from products p
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(p.tags) = 'array' then p.tags else '[]'::jsonb end
    ) as tag(value)
    where ${isPublicAs("p")}
      and search_normalize(tag.value) like ${`${plan.normalized}%`}
      and search_normalize(tag.value) <> ${plan.normalized}
    group by search_normalize(tag.value)
    order by count(*) desc, min(tag.value)
    limit 3
  `);
  return rows.map((row) => row.tag);
}

async function brandSuggestions(plan: SearchPlan): Promise<string[]> {
  const rows = await db
    .selectDistinct({ brand: products.brand })
    .from(products)
    .where(
      and(
        publicProductWhere,
        eq(products.searchable, true),
        sql`search_normalize(${products.brand}) like ${`${plan.normalized}%`}`,
      ),
    )
    .orderBy(asc(products.brand))
    .limit(2);

  return rows
    .map((row) => row.brand)
    .filter((brand): brand is string => Boolean(brand));
}

/** Categories named like the search that have something public in them. */
async function categoriesByName(plan: SearchPlan) {
  return db
    .select({ name: categories.name, slug: categories.slug })
    .from(categories)
    .where(
      and(
        sql`search_normalize(${categories.name}) like ${`%${plan.normalized}%`}`,
        sql`(
          exists (
            select 1 from products p
            where p.category_id = ${categories.id} and ${isPublicAs("p")}
          )
          or exists (
            select 1 from categories c2
            join products p on p.category_id = c2.id
            where c2.parent_id = ${categories.id} and ${isPublicAs("p")}
          )
        )`,
      ),
    )
    .orderBy(asc(categories.name))
    .limit(2);
}

export async function suggest(term: string): Promise<SuggestResult> {
  const query = cleanQuery(term);
  if (query.length < 2) return { suggestions: [], correctedQuery: null };

  let plan = await planSearch(query);
  if (!plan) return { suggestions: [], correctedQuery: null };

  let found = await candidates(plan);
  let correctedQuery: string | null = null;

  // Nothing as typed: try the likely spelling before giving up.
  if (found.length === 0) {
    const corrected = await correctSearch(plan);
    if (corrected) {
      const retry = await candidates(corrected);
      if (retry.length > 0) {
        plan = corrected;
        found = retry;
        correctedQuery = corrected.query;
      }
    }
  }

  const shown = found.slice(0, MAX_PRODUCTS);
  const [aggregates, brands, namedCategories, tags, popular] = await Promise.all([
    loadCardAggregates(shown.map((row) => row.id)),
    brandSuggestions(plan),
    categoriesByName(plan),
    tagCompletions(plan),
    popularSearches({ prefix: plan.query, limit: 3 }),
  ]);

  const completions = [
    ...new Map(
      [...popular, ...completionsFrom(plan, found.map((row) => row.title)), ...tags]
        .filter((label) => label.toLowerCase() !== plan.normalized)
        .map((label) => [label.toLowerCase(), label] as const),
    ).values(),
  ].slice(0, MAX_COMPLETIONS);

  // The shelves most of the matches sit on, as "iphone in Phones".
  const shelfCounts = new Map<string, { name: string; slug: string; count: number }>();
  for (const row of found) {
    const entry = shelfCounts.get(row.categorySlug) ?? {
      name: row.categoryName,
      slug: row.categorySlug,
      count: 0,
    };
    entry.count += 1;
    shelfCounts.set(row.categorySlug, entry);
  }
  const shelves = [...shelfCounts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 2);

  const suggestions: Suggestion[] = [
    ...shown.map((row) => ({
      kind: "product" as const,
      label: row.title,
      href: `/products/${row.slug}`,
      thumbnailUrl: aggregates.get(row.id)?.imageUrl ?? null,
      hint: row.brand ?? row.categoryName,
      priceBdt: aggregates.get(row.id)?.fromPriceBdt ?? null,
    })),
    ...shelves.map((shelf) => ({
      kind: "category" as const,
      label: shelf.name,
      href: searchHref(plan!.query, shelf.slug),
      scope: plan!.query,
    })),
    ...namedCategories
      .filter((category) => !shelves.some((shelf) => shelf.slug === category.slug))
      .map((category) => ({
        kind: "category" as const,
        label: category.name,
        href: `/categories/${category.slug}`,
        hint: "Category",
      })),
    ...brands.map((brand) => ({
      kind: "brand" as const,
      label: brand,
      href: searchHref(brand),
    })),
    ...completions.map((label) => ({
      kind: "search" as const,
      label,
      href: searchHref(label),
    })),
  ];

  return { suggestions, correctedQuery };
}

/** The suggestions alone, for callers that do not show a correction. */
export async function suggestSearch(
  term: string,
  limit = 16,
): Promise<Suggestion[]> {
  return (await suggest(term)).suggestions.slice(0, limit);
}

/**
 * What to offer before anything is typed: searches enough people ran that
 * found something. Empty until the shop has that much real traffic — no
 * placeholder trends.
 */
export async function searchInspiration(): Promise<{
  popular: string[];
  trending: string[];
}> {
  const [popular, trending] = await Promise.all([
    popularSearches({ limit: 6 }),
    trendingSearches(4),
  ]);

  return {
    popular,
    trending: trending.filter(
      (entry) =>
        !popular.some((item) => item.toLowerCase() === entry.toLowerCase()),
    ),
  };
}
