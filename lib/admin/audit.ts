import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Reading the audit log.
 *
 * The log is insert-only from application code; nothing here writes or
 * deletes. It is the record of who changed what, so being able to read it is
 * the point of keeping it.
 *
 * Entries are ordered by (created_at, id). The timestamp alone is not an
 * order: every entry written in one transaction carries the same one, so
 * paging by it could show an entry twice or not at all.
 */

export type AuditFilter = {
  action?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
};

const entryColumns = {
  id: auditLog.id,
  action: auditLog.action,
  entityType: auditLog.entityType,
  entityId: auditLog.entityId,
  beforeJson: auditLog.beforeJson,
  afterJson: auditLog.afterJson,
  createdAt: auditLog.createdAt,
  actorEmail: users.email,
};

function filterConditions(filter: Pick<AuditFilter, "action" | "entityType">) {
  const conditions = [];
  if (filter.action) conditions.push(eq(auditLog.action, filter.action));
  if (filter.entityType) conditions.push(eq(auditLog.entityType, filter.entityType));
  return conditions;
}

export async function listAuditEntries(
  actor: SessionUser | null,
  filter: AuditFilter = {},
) {
  requirePermission(actor, "audit.view");

  const conditions = filterConditions(filter);

  return db
    .select(entryColumns)
    .from(auditLog)
    .innerJoin(users, eq(auditLog.actorUserId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A page cursor from the address bar: an entry id, or nothing if malformed. */
export function decodeAuditCursor(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

export type AuditPageQuery = Pick<AuditFilter, "action" | "entityType"> & {
  limit?: number;
  /** Older entries than this one. */
  after?: string;
  /** Newer entries than this one. */
  before?: string;
};

/**
 * One page of the log, newest first, by keyset.
 *
 * Each page costs the same however far back it is, which an offset does not:
 * the log only grows. The cursor is an entry id and the comparison uses that
 * row's stored values, so no precision is lost between pages.
 */
export async function listAuditPage(actor: SessionUser | null, query: AuditPageQuery = {}) {
  requirePermission(actor, "audit.view");

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const backwards = Boolean(query.before);
  const cursor = query.before ?? query.after;
  const boundary = cursor
    ? sql`(select b.created_at, b.id from audit_log b where b.id = ${cursor}::uuid)`
    : undefined;
  const cursorCondition = boundary
    ? backwards
      ? sql`(${auditLog.createdAt}, ${auditLog.id}) > ${boundary}`
      : sql`(${auditLog.createdAt}, ${auditLog.id}) < ${boundary}`
    : undefined;

  const fetched = await db
    .select(entryColumns)
    .from(auditLog)
    .innerJoin(users, eq(auditLog.actorUserId, users.id))
    .where(and(...filterConditions(query), cursorCondition))
    .orderBy(
      ...(backwards
        ? [asc(auditLog.createdAt), asc(auditLog.id)]
        : [desc(auditLog.createdAt), desc(auditLog.id)]),
    )
    // One extra row says whether there is a further page.
    .limit(limit + 1);

  const more = fetched.length > limit;
  const entries = fetched.slice(0, limit);
  if (backwards) entries.reverse();

  const first = entries[0];
  const last = entries.at(-1);
  return {
    entries,
    nextCursor: last && (backwards || more) ? last.id : null,
    previousCursor: first && (backwards ? more : Boolean(query.after)) ? first.id : null,
  };
}

/**
 * Distinct actions recorded so far, for the filter control.
 *
 * Read by skipping from one action to the next along the action index rather
 * than grouping the whole log, so it costs one index probe per distinct
 * action however long the log grows.
 */
export async function listAuditActions(actor: SessionUser | null) {
  requirePermission(actor, "audit.view");

  const result = await db.execute(sql`
    with recursive actions(action) as (
      (select action from audit_log order by action limit 1)
      union all
      select (select a.action from audit_log a where a.action > actions.action order by a.action limit 1)
      from actions
      where actions.action is not null
    )
    select action from actions where action is not null
  `);
  // postgres-js returns the rows; the in-process test database wraps them.
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { action: string }[];

  return rows.map((row) => row.action);
}

export async function countAuditEntries(
  actor: SessionUser | null,
  filter: AuditFilter = {},
): Promise<number> {
  requirePermission(actor, "audit.view");

  const conditions = filterConditions(filter);

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return row.value;
}
