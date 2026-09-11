import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { searchSynonyms } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { SynonymInput } from "@/lib/validation/search";
import type { Slot } from "./normalize";
import { textArray } from "./sql";

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

async function assertTermIsFree(term: string, excludingId?: string) {
  const [clash] = await db
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
): Promise<SynonymEntry> {
  const staff = requirePermission(actor, "search.manage");
  await assertTermIsFree(input.term);

  return db.transaction(async (tx) => {
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
  });
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

/** Every run of one to three consecutive words, which is what an entry can match. */
function phrasesIn(words: string[]): string[] {
  const phrases = new Set<string>();
  for (let start = 0; start < words.length; start++) {
    for (let length = 1; length <= 3 && start + length <= words.length; length++) {
      phrases.add(words.slice(start, start + length).join(" "));
    }
  }
  return [...phrases];
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
 * Splits a search into slots, taking the longest phrase an entry covers at
 * each position, so "cell phone case" with an entry for "cell phone" becomes
 * [cell phone | phone | mobile] [case] rather than three separate words.
 */
export function buildSlots(
  words: string[],
  synonyms: Map<string, string[][]>,
): Slot[] {
  const slots: Slot[] = [];
  let index = 0;

  while (index < words.length) {
    let taken = 0;

    for (let length = Math.min(3, words.length - index); length >= 1; length--) {
      const phrase = words.slice(index, index + length);
      const alternatives = synonyms.get(phrase.join(" "));
      if (alternatives && alternatives.length > 0) {
        slots.push({ typed: phrase, alternatives: [phrase, ...alternatives] });
        taken = length;
        break;
      }
    }

    if (taken === 0) {
      slots.push({ typed: [words[index]], alternatives: [[words[index]]] });
      taken = 1;
    }

    index += taken;
  }

  return slots;
}
