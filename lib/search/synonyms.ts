import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { searchSynonyms } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { Executor } from "@/lib/pkb/common";
import type { SynonymInput } from "@/lib/validation/search";
import { phrasesIn, type KnowledgeMap } from "./knowledge";
import { wordSlot, type Slot } from "./normalize";
import { textArray } from "./sql";
import { quantitiesIn, valueTerm, type QuantityInQuery } from "./terms";

/**
 * Synonyms: what else a word should find.
 *
 * Staff write every one of them. Nothing here is generated or learned,
 * because a wrong synonym does not fail loudly — it quietly fills a results
 * page with products nobody asked for, and the shopper blames the shop.
 *
 * An entry is a term and what it should also find. A two-way entry works in
 * both directions ("earbuds" ⇄ "earphones"); a one-way entry does not
 * ("cellphone" → "phone" should not make every phone answer to "cellphone"…
 * though here it would be harmless, "mobile" → "phone" and back would send a
 * search for a phone to every mobile-anything).
 */

export type SynonymEntry = {
  id: string;
  term: string;
  synonyms: string[];
  bidirectional: boolean;
  updatedAt: Date;
};

export class SynonymError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SynonymError";
    this.status = status;
  }
}

const columns = {
  id: searchSynonyms.id,
  term: searchSynonyms.term,
  synonyms: searchSynonyms.synonyms,
  bidirectional: searchSynonyms.bidirectional,
  updatedAt: searchSynonyms.updatedAt,
};

export async function listSynonyms(
  actor: SessionUser | null,
): Promise<SynonymEntry[]> {
  requirePermission(actor, "search.manage");
  return db.select(columns).from(searchSynonyms).orderBy(asc(searchSynonyms.term));
}

async function assertTermIsFree(term: string, excludingId?: string, executor: Executor = db) {
  const [clash] = await executor
    .select({ id: searchSynonyms.id })
    .from(searchSynonyms)
    .where(eq(searchSynonyms.term, term))
    .limit(1);

  if (clash && clash.id !== excludingId) {
    throw new SynonymError(
      `“${term}” already has an entry. Edit that one instead.`,
      409,
    );
  }
}

export async function createSynonym(
  actor: SessionUser | null,
  input: SynonymInput,
  /** A transaction to write inside, when this is one step of a larger decision (D-075). */
  options: { executor?: Executor } = {},
): Promise<SynonymEntry> {
  const staff = requirePermission(actor, "search.manage");
  await assertTermIsFree(input.term, undefined, options.executor);

  const write = async (tx: Executor) => {
    const [created] = await tx
      .insert(searchSynonyms)
      .values({
        term: input.term,
        synonyms: input.synonyms,
        bidirectional: input.bidirectional,
        createdBy: staff.id,
      })
      .returning(columns);

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "search.synonym_created",
        entityType: "search_synonym",
        entityId: created.id,
        after: input,
      },
      tx,
    );

    return created;
  };

  return options.executor ? write(options.executor) : db.transaction(write);
}

export async function updateSynonym(
  actor: SessionUser | null,
  id: string,
  input: SynonymInput,
): Promise<SynonymEntry> {
  const staff = requirePermission(actor, "search.manage");

  const [before] = await db
    .select(columns)
    .from(searchSynonyms)
    .where(eq(searchSynonyms.id, id));
  if (!before) throw new SynonymError("That synonym no longer exists.", 404);

  await assertTermIsFree(input.term, id);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(searchSynonyms)
      .set({
        term: input.term,
        synonyms: input.synonyms,
        bidirectional: input.bidirectional,
        updatedAt: new Date(),
      })
      .where(eq(searchSynonyms.id, id))
      .returning(columns);

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "search.synonym_updated",
        entityType: "search_synonym",
        entityId: id,
        before: {
          term: before.term,
          synonyms: before.synonyms,
          bidirectional: before.bidirectional,
        },
        after: input,
      },
      tx,
    );

    return updated;
  });
}

export async function deleteSynonym(
  actor: SessionUser | null,
  id: string,
): Promise<void> {
  const staff = requirePermission(actor, "search.manage");

  const [before] = await db
    .select(columns)
    .from(searchSynonyms)
    .where(eq(searchSynonyms.id, id));
  if (!before) throw new SynonymError("That synonym no longer exists.", 404);

  await db.transaction(async (tx) => {
    await tx.delete(searchSynonyms).where(eq(searchSynonyms.id, id));

    // The entry itself is gone, so the audit row is the only record of what
    // the search used to do.
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "search.synonym_deleted",
        entityType: "search_synonym",
        entityId: id,
        before: {
          term: before.term,
          synonyms: before.synonyms,
          bidirectional: before.bidirectional,
        },
      },
      tx,
    );
  });
}


/**
 * The synonyms that apply to a search: phrase to the phrases it should also
 * find, each split into words. One small indexed query.
 */
export async function loadSynonymMap(
  words: string[],
): Promise<Map<string, string[][]>> {
  const phrases = phrasesIn(words);
  const map = new Map<string, Set<string>>();
  if (phrases.length === 0) return new Map();

  const rows = await db
    .select({
      term: searchSynonyms.term,
      synonyms: searchSynonyms.synonyms,
      bidirectional: searchSynonyms.bidirectional,
    })
    .from(searchSynonyms)
    .where(
      sql`${searchSynonyms.term} = any(${textArray(phrases)})
        or (${searchSynonyms.bidirectional}
            and ${searchSynonyms.synonyms} && ${textArray(phrases)})`,
    );

  const add = (from: string, to: string) => {
    if (from === to) return;
    const set = map.get(from) ?? new Set<string>();
    set.add(to);
    map.set(from, set);
  };

  for (const row of rows) {
    for (const synonym of row.synonyms) add(row.term, synonym);

    if (row.bidirectional) {
      for (const synonym of row.synonyms) {
        add(synonym, row.term);
        for (const other of row.synonyms) add(synonym, other);
      }
    }
  }

  return new Map(
    [...map.entries()].map(([phrase, targets]) => [
      phrase,
      [...targets].map((target) => target.split(" ")),
    ]),
  );
}

/**
 * Where each quantity in a search sits among its words.
 *
 * "512gb" is one word; "6.1 inch" is three once punctuation is split on. Both
 * have to become one position, so the span is found by tokenising the quantity
 * the same way the search was tokenised and looking for that run of words.
 */
function quantitySpans(
  query: string,
  words: string[],
): Map<number, { length: number; quantity: QuantityInQuery }> {
  const spans = new Map<number, { length: number; quantity: QuantityInQuery }>();
  const taken = new Set<number>();

  for (const quantity of quantitiesIn(query)) {
    const needle = quantity.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (needle.length === 0) continue;

    for (let start = 0; start + needle.length <= words.length; start++) {
      if (taken.has(start)) continue;
      if (!needle.every((word, offset) => words[start + offset] === word)) continue;
      spans.set(start, { length: needle.length, quantity });
      for (let offset = 0; offset < needle.length; offset++) taken.add(start + offset);
      break;
    }
  }

  return spans;
}

/** "256gb" as the two words a listing that wrote "256 GB" was indexed under. */
function splitQuantityWords(word: string): string[] {
  const match = /^(\d+)([\p{L}]+)$/u.exec(word);
  return match ? [match[1], match[2]] : [word];
}

/**
 * Splits a search into slots, taking the longest phrase anything covers at
 * each position, so "cell phone case" with an entry for "cell phone" becomes
 * [cell phone | phone | mobile] [case] rather than three separate words.
 *
 * Three things can claim a position, in this order:
 *
 *  1. a quantity — "512 gb" becomes one position carrying the canonical value,
 *     so it cannot be broken up and half-matched;
 *  2. a staff-written synonym, longest phrase first (unchanged);
 *  3. the knowledge base — an approved alias, a brand or a family name, which
 *     adds both the other spellings and the structured term.
 *
 * A word claimed by none of them is its own plain slot, exactly as before.
 */
export function buildSlots(
  words: string[],
  synonyms: Map<string, string[][]>,
  options: { knowledge?: KnowledgeMap; query?: string } = {},
): Slot[] {
  const knowledge = options.knowledge ?? new Map();
  const spans = options.query ? quantitySpans(options.query, words) : new Map();
  const slots: Slot[] = [];
  let index = 0;

  while (index < words.length) {
    const span = spans.get(index);
    if (span) {
      const phrase = words.slice(index, index + span.length);
      /*
       * Still searched as words, in both the ways a quantity is written. A
       * listing whose value the knowledge base has not mapped yet only has the
       * text, and that text may say "512GB" or "512 GB" — someone typing
       * either must find both. The canonical term is what matches a listing
       * whose value *is* in the knowledge base, however it was written there.
       */
      const joined = phrase.join("");
      const split = phrase.length === 1 ? splitQuantityWords(phrase[0]) : phrase;
      const alternatives = new Map<string, string[]>();
      for (const alternative of [phrase, split, [joined]]) {
        if (alternative.length > 0) alternatives.set(alternative.join(" "), alternative);
      }

      slots.push({
        typed: phrase,
        alternatives: [...alternatives.values()],
        terms: [span.quantity.term],
        structural: true,
      });
      index += span.length;
      continue;
    }

    let taken = 0;

    for (let length = Math.min(3, words.length - index); length >= 1; length--) {
      const phrase = words.slice(index, index + length);
      const key = phrase.join(" ");
      const synonymAlternatives = synonyms.get(key) ?? [];
      const known = knowledge.get(key);
      if (synonymAlternatives.length === 0 && !known) continue;

      const alternatives = [phrase, ...synonymAlternatives, ...(known?.words ?? [])];
      const unique = new Map(alternatives.map((entry) => [entry.join(" "), entry]));
      slots.push({
        typed: phrase,
        alternatives: [...unique.values()],
        terms: known?.terms ?? [],
        structural: false,
      });
      taken = length;
      break;
    }

    if (taken === 0) {
      const word = words[index];
      const slot = wordSlot(word);
      // A bare word may still be a value the knowledge base holds — "black" is
      // a colour whichever attribute records it. This can only widen: a
      // product has to actually carry that value for the term to match.
      slot.terms = [valueTerm(word)];
      slots.push(slot);
      taken = 1;
    }

    index += taken;
  }

  return slots;
}
