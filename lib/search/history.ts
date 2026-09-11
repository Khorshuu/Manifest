import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { searchHistory } from "@/db/schema";
import { requireUser } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { cleanQuery, looksPersonal, normalizeText } from "./normalize";

/**
 * A signed-in customer's own recent searches, so they follow them from phone
 * to laptop. A guest's live in their browser instead (components/search-box).
 *
 * Every function acts on the signed-in account and nothing else — there is no
 * way to name another user here. Searches that look like an email address or
 * a phone number are never kept, and the whole list goes when the account is
 * anonymised (lib/auth/anonymise.ts).
 */

/** Enough to be useful, few enough that the list is not a diary. */
export const HISTORY_LIMIT = 20;

export async function recordSearchHistory(
  actor: SessionUser | null,
  raw: string,
): Promise<void> {
  const user = requireUser(actor);
  const query = cleanQuery(raw);
  const normalized = normalizeText(query);
  if (!normalized || looksPersonal(query)) return;

  try {
    await db
      .insert(searchHistory)
      .values({ userId: user.id, query, queryNorm: normalized })
      .onConflictDoUpdate({
        target: [searchHistory.userId, searchHistory.queryNorm],
        set: { query, searchedAt: new Date() },
      });

    // Keep the newest few; the rest go.
    await db.execute(sql`
      delete from search_history
      where user_id = ${user.id}
        and query_norm not in (
          select query_norm from search_history
          where user_id = ${user.id}
          order by searched_at desc
          limit ${HISTORY_LIMIT}
        )
    `);
  } catch (error) {
    console.error("Could not record search history.", error);
  }
}

export async function listSearchHistory(
  actor: SessionUser | null,
  limit = 8,
): Promise<string[]> {
  const user = requireUser(actor);

  const rows = await db
    .select({ query: searchHistory.query })
    .from(searchHistory)
    .where(eq(searchHistory.userId, user.id))
    .orderBy(desc(searchHistory.searchedAt))
    .limit(Math.min(limit, HISTORY_LIMIT));

  return rows.map((row) => row.query);
}

export async function removeSearchHistory(
  actor: SessionUser | null,
  raw: string,
): Promise<void> {
  const user = requireUser(actor);
  const normalized = normalizeText(cleanQuery(raw));
  if (!normalized) return;

  await db
    .delete(searchHistory)
    .where(
      and(
        eq(searchHistory.userId, user.id),
        eq(searchHistory.queryNorm, normalized),
      ),
    );
}

export async function clearSearchHistory(
  actor: SessionUser | null,
): Promise<void> {
  const user = requireUser(actor);
  await db.delete(searchHistory).where(eq(searchHistory.userId, user.id));
}
