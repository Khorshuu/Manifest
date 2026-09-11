import { and, desc, eq, sql } from "drizzle-orm";
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
 */

export type AuditFilter = {
  action?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
};

export async function listAuditEntries(
  actor: SessionUser | null,
  filter: AuditFilter = {},
) {
  requirePermission(actor, "audit.view");

  const conditions = [];
  if (filter.action) conditions.push(eq(auditLog.action, filter.action));
  if (filter.entityType) {
    conditions.push(eq(auditLog.entityType, filter.entityType));
  }

  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      beforeJson: auditLog.beforeJson,
      afterJson: auditLog.afterJson,
      createdAt: auditLog.createdAt,
      actorEmail: users.email,
    })
    .from(auditLog)
    .innerJoin(users, eq(auditLog.actorUserId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0);
}

/** Distinct actions recorded so far, for the filter control. */
export async function listAuditActions(actor: SessionUser | null) {
  requirePermission(actor, "audit.view");

  const rows = await db
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .orderBy(auditLog.action);

  return rows.map((row) => row.action);
}

export async function countAuditEntries(
  actor: SessionUser | null,
  filter: AuditFilter = {},
): Promise<number> {
  requirePermission(actor, "audit.view");

  const conditions = [];
  if (filter.action) conditions.push(eq(auditLog.action, filter.action));
  if (filter.entityType) {
    conditions.push(eq(auditLog.entityType, filter.entityType));
  }

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return row.value;
}
