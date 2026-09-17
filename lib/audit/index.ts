import type { PgTransaction } from "drizzle-orm/pg-core";
import { db, runAfterCommit } from "@/db";
import { auditLog } from "@/db/schema";
import { invalidateForAudit } from "@/lib/cache";

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
  | "search.reindexed"
  /** A product option or its values: added, removed, reordered. */
  | "attribute.updated"
  /** Product Knowledge Base — docs/KNOWLEDGE_PLATFORM.md. */
  | "knowledge.family_suggested"
  | "knowledge.family_approved"
  | "knowledge.family_rejected"
  | "knowledge.family_version_drafted"
  | "knowledge.family_version_activated"
  | "knowledge.family_assigned"
  | "knowledge.definition_created"
  | "knowledge.definition_decided"
  | "knowledge.fact_set"
  | "knowledge.fact_cleared"
  | "knowledge.fact_locked"
  | "knowledge.fact_unlocked"
  | "knowledge.identifier_changed"
  | "knowledge.source_recorded"
  | "knowledge.claim_proposed"
  | "knowledge.relationship_added"
  | "knowledge.relationship_removed"
  | "knowledge.alias_suggested"
  | "knowledge.alias_decided"
  | "knowledge.registry_suggested"
  | "knowledge.registry_decided"
  | "knowledge.policy_changed"
  | "knowledge.claims_accepted"
  | "knowledge.claims_rejected"
  | "knowledge.identity_resolved"
  | "knowledge.label_mapped"
  | "knowledge.proposal_decided"
  | "knowledge.enrichment_requested"
  | "knowledge.source_added";

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

  // Cached storefront data this change affects (lib/cache.ts, D-054), once
  // the transaction has committed, so no request can re-cache the old rows.
  const invalidate = () => invalidateForAudit(entry.entityType);
  if (!runAfterCommit(invalidate)) invalidate();
}
