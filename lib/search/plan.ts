import { sql } from "drizzle-orm";
import {
  cleanQuery,
  codeKey,
  combinedTsQuery,
  isStopword,
  looksLikeCode,
  normalizeText,
  queryTokens,
  queryWords,
} from "./normalize";
import { isPublicAs, queryRows, textArray, type SearchPlan } from "./sql";
import { buildSlots, loadSynonymMap } from "./synonyms";

export type { SearchPlan } from "./sql";

/**
 * Reads a search: cleans it, splits it into words, applies the synonyms staff
 * have written, and builds the tsquery. Returns null when nothing searchable
 * is left — "???" narrows nothing rather than matching nothing, which is what
 * someone who typed it is better served by.
 */
export async function planSearch(
  raw: unknown,
  options: { synonyms?: boolean } = {},
): Promise<SearchPlan | null> {
  const query = cleanQuery(raw);
  const words = queryWords(query);
  if (words.length === 0) return null;

  const synonyms =
    options.synonyms === false ? new Map() : await loadSynonymMap(words);
  const slots = buildSlots(words, synonyms);

  return {
    query,
    normalized: normalizeText(query),
    words,
    slots,
    tsquery: combinedTsQuery(slots),
    code: looksLikeCode(query) ? codeKey(query) : null,
    correctedFrom: null,
  };
}

/** Words worth checking for a typo: long enough, not a number, not a stop word. */
function checkable(words: string[]): string[] {
  return [
    ...new Set(
      words.filter(
        (word) => word.length >= 3 && /\p{L}/u.test(word) && !isStopword(word),
      ),
    ),
  ];
}

/**
 * The words of a search that find nothing public on their own — through the
 * document or inside a name. One indexed query for all of them.
 */
export async function unmatchedWords(words: string[]): Promise<string[]> {
  const candidates = checkable(words);
  if (candidates.length === 0) return [];

  const rows = await queryRows<{ word: string }>(sql`
    select w.word
    from unnest(${textArray(candidates)}) as w(word)
    where not exists (
      select 1
      from product_search ps
      join products p on p.id = ps.product_id
      where ${isPublicAs("p")}
        and (
          ps.document @@ to_tsquery('english', w.word || ':*')
          or ps.title_norm like '%' || w.word || '%'
        )
    )
  `);

  return rows.map((row) => row.word);
}

/**
 * The listing word a misspelling most likely meant, or null.
 *
 * Trigram similarity against the vocabulary of what is actually on sale, so a
 * correction always leads somewhere. Two guards keep it from inventing: the
 * first letter must agree (people rarely mistype the first letter, and it
 * stops "bag" becoming "rag"), and the similarity has to clear 0.35 — enough
 * for "samsng" → "samsung" (0.5) and "bluetooh" → "bluetooth" (0.58), not
 * enough for two short unrelated words that share a syllable.
 */
export async function closestWord(
  word: string,
): Promise<{ word: string; display: string } | null> {
  const rows = await queryRows<{ word: string; display: string; score: number }>(sql`
    select
      w.word,
      (array_agg(w.display order by w.weight desc))[1] as display,
      similarity(w.word, ${word})::float8 as score
    from product_search_words w
    join products p on p.id = w.product_id
    where w.word % ${word}
      and left(w.word, 1) = left(${word}, 1)
      and w.word ~ '[a-z]'
      and ${isPublicAs("p")}
    group by w.word
    having similarity(w.word, ${word}) >= 0.35
    order by score desc, max(w.weight) desc, count(distinct w.product_id) desc
    limit 1
  `);

  return rows[0] ? { word: rows[0].word, display: rows[0].display } : null;
}

/**
 * A corrected version of a search that found nothing, or null when there is no
 * confident correction. Only the words that found nothing are replaced; the
 * rest are kept exactly as typed, so "Samsng Galaxy" becomes "Samsung Galaxy"
 * rather than "samsung galaxy".
 */
export async function correctSearch(
  plan: SearchPlan,
): Promise<SearchPlan | null> {
  const unmatched = await unmatchedWords(plan.words);
  if (unmatched.length === 0) return null;

  const replacements = new Map<string, string>();
  await Promise.all(
    unmatched.map(async (word) => {
      const best = await closestWord(word);
      if (best && best.word !== word) replacements.set(word, best.display);
    }),
  );
  if (replacements.size === 0) return null;

  const tokens = queryTokens(plan.query);
  const corrected = plan.words
    .map((word, index) => replacements.get(word) ?? tokens[index] ?? word)
    .join(" ");

  const next = await planSearch(corrected);
  return next ? { ...next, correctedFrom: plan.query } : null;
}
