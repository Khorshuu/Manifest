import type { PgTransaction } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

export type AuditAction =
  | "user.role_changed"
  | "user.created"
  | "user.deactivated"
  | "product.created"
  | "product.updated"
  | "product.deleted"
  | "product.duplicated"
  | "variant.deleted"
  | "variant.archived"
  | "variant.restored"
  | "seo_pulse.researched"
  | "seo_pulse.applied"
  | "product.archived"
  | "product.price_changed"
  | "variant.created"
  | "variant.updated"
  | "variant.capacity_changed"
  | "category.created"
  | "category.updated"
  | "order.status_changed"
  | "order.refunded"
  /** The balance on a deposit order, taken by staff — DECISIONS.md D-012. */
  | "order.balance_taken"
  | "review.moderated"
  | "user.two_factor_enabled"
  | "user.two_factor_disabled"
  | "site_settings.updated"
  | "sku.reserved"
  | "sku.released"
  | "sku.finalized"
  /** Search synonyms and index maintenance — docs/BUSINESS_LOGIC.md, search. */
  | "search.synonym_created"
  | "search.synonym_updated"
  | "search.synonym_deleted"
  | "search.reindexed";

export type AuditEntry = {
  actorUserId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Writes one audit row. Always pass the surrounding transaction so the entry
 * commits with the mutation it records — an audit entry that can fail on its
 * own is not an audit trail (docs/BUSINESS_LOGIC.md).
 */
export async function recordAudit(
  entry: AuditEntry,
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts either
     the base database or an open transaction, which differ only in generics */
  tx: { insert: typeof db.insert } | PgTransaction<any, any, any> = db,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    beforeJson: entry.before === undefined ? null : entry.before,
    afterJson: entry.after === undefined ? null : entry.after,
  });
}
