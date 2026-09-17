import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { pkbProducts, pkbRelationships, type PkbRelationshipKind } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { PkbError, type Executor } from "./common";
import { createStaffEntrySource } from "./store";

/**
 * Factual relationships between products (D-061): accessories, compatibility,
 * successors, replacements, bundles, series. Either end may be a product
 * Manifest does not sell. These are facts with provenance — separate from
 * `product_related`, which is merchandising.
 */

export const SYMMETRIC_KINDS = new Set<PkbRelationshipKind>(["related_to", "same_series"]);

/** How a relationship reads from its other end. */
export const INVERSE_LABELS: Record<PkbRelationshipKind, { outgoing: string; incoming: string }> = {
  accessory_for: { outgoing: "Accessory for", incoming: "Accessories" },
  compatible_with: { outgoing: "Works with", incoming: "Works with this" },
  successor_of: { outgoing: "Successor of", incoming: "Predecessor of" },
  replacement_for: { outgoing: "Replaces", incoming: "Replaced by" },
  bundle_contains: { outgoing: "Bundle includes", incoming: "Included in bundle" },
  requires: { outgoing: "Requires", incoming: "Required by" },
  related_to: { outgoing: "Related to", incoming: "Related to" },
  same_series: { outgoing: "Same series as", incoming: "Same series as" },
};

export async function addRelationship(
  actor: SessionUser | null,
  input: { fromProductId: string; toProductId: string; kind: PkbRelationshipKind; note?: string | null },
) {
  const staff = requirePermission(actor, "catalog.manage");
  if (input.fromProductId === input.toProductId) throw new PkbError("A product cannot be related to itself.");
  if (!(input.kind in INVERSE_LABELS)) throw new PkbError("Unknown relationship kind.");

  // Symmetric relationships are stored once, in id order.
  const [from, to] =
    SYMMETRIC_KINDS.has(input.kind) && input.toProductId < input.fromProductId
      ? [input.toProductId, input.fromProductId]
      : [input.fromProductId, input.toProductId];

  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: pkbProducts.id })
      .from(pkbProducts)
      .where(or(eq(pkbProducts.id, from), eq(pkbProducts.id, to)));
    if (found.length !== 2) throw new PkbError("Both products must be in the knowledge base.", 404);

    const [existing] = await tx
      .select()
      .from(pkbRelationships)
      .where(and(eq(pkbRelationships.fromProductId, from), eq(pkbRelationships.toProductId, to), eq(pkbRelationships.kind, input.kind)));
    if (existing) return existing;

    const sourceId = await createStaffEntrySource(tx, staff.id, "Relationship entered in the knowledge base");
    const [row] = await tx
      .insert(pkbRelationships)
      .values({
        fromProductId: from,
        toProductId: to,
        kind: input.kind,
        verificationState: "MANUAL",
        origin: "MANUAL_ADMIN",
        sourceId,
        decidedBy: staff.id,
        note: input.note?.slice(0, 500) ?? null,
      })
      .returning();
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.relationship_added", entityType: "pkb_product", entityId: from, after: { to, kind: input.kind } },
      tx,
    );
    return row;
  });
}

export async function removeRelationship(actor: SessionUser | null, relationshipId: string) {
  const staff = requirePermission(actor, "catalog.manage");
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(pkbRelationships).where(eq(pkbRelationships.id, relationshipId)).for("update");
    if (!row) throw new PkbError("That relationship no longer exists.", 404);
    if (row.lockedAt) throw new PkbError("That relationship is locked. Unlock it first.", 409);
    await tx.delete(pkbRelationships).where(eq(pkbRelationships.id, relationshipId));
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.relationship_removed",
        entityType: "pkb_product",
        entityId: row.fromProductId,
        before: { to: row.toProductId, kind: row.kind, state: row.verificationState },
      },
      tx,
    );
  });
}

/** A product's relationships from its own point of view, both directions. */
export async function listRelationships(executor: Executor, pkbProductId: string) {
  const rows: (typeof pkbRelationships.$inferSelect)[] = await executor
    .select()
    .from(pkbRelationships)
    .where(or(eq(pkbRelationships.fromProductId, pkbProductId), eq(pkbRelationships.toProductId, pkbProductId)));
  return rows.map((row) => {
    const outgoing = row.fromProductId === pkbProductId || SYMMETRIC_KINDS.has(row.kind);
    return {
      id: row.id,
      kind: row.kind,
      label: outgoing ? INVERSE_LABELS[row.kind].outgoing : INVERSE_LABELS[row.kind].incoming,
      otherProductId: row.fromProductId === pkbProductId ? row.toProductId : row.fromProductId,
      verificationState: row.verificationState,
      origin: row.origin,
      locked: Boolean(row.lockedAt),
    };
  });
}
