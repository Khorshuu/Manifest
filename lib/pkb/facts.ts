import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { pkbClaims, pkbFacts, pkbProducts, pkbVariants, products, type PkbVerificationState } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { lockListingKnowledge, PkbError, PkbLockedError, queryRows, staffChange, type Executor } from "./common";
import { resolveFamilySchema, type FamilySchemaAttribute } from "./families";
import { applyProjection, isProjectable } from "./projection";
import {
  createStaffEntrySource,
  deleteFact,
  ensureBrand,
  insertFact,
  notApplicableValue,
  readValue,
  sameStoredValue,
  slotKey,
  updateFact,
  type FactRow,
  type FactValue,
  type Provenance,
} from "./store";
import { beginListingChange, syncListingKnowledge } from "./sync";
import { LEGACY_DETAIL_DEFINITIONS, loadDefinitions, type DefinitionRecord } from "./vocabulary";

/**
 * Writing facts directly in the knowledge base, and reading a product's slots.
 *
 * These are the primitives the Stage 3 review screens call: set a value by
 * hand, clear it, lock it, unlock it. Every one checks permission here, runs
 * in one transaction with its history row, and writes the listing's legacy
 * column back when the value is mirrored there, so the storefront and the
 * knowledge base never disagree.
 */

export type SlotState =
  | "VERIFIED"
  | "MANUAL"
  | "UNVERIFIED"
  | "LEGACY"
  | "LOCKED"
  | "SUGGESTED"
  | "CONFLICT"
  | "NOT_APPLICABLE"
  | "UNKNOWN";

/** The state a fact shows as: a lock wins, then not-applicable, then how it was established. */
export function effectiveFactState(fact: Pick<FactRow, "lockedAt" | "valueStatus" | "verificationState">): SlotState {
  if (fact.lockedAt) return "LOCKED";
  if (fact.valueStatus === "not_applicable") return "NOT_APPLICABLE";
  return fact.verificationState as PkbVerificationState;
}

export type DecidedFactWrite = {
  pkbProductId: string;
  pkbVariantId: string | null;
  definition: DefinitionRecord;
  ordinal: number;
  value: FactValue;
  provenance: Provenance;
  listings: string[];
  actorId: string;
  reason: string;
  /** Replace a MANUAL or VERIFIED value that says something different. */
  overrideDecided?: boolean;
};

/**
 * Writes a value a person decided — typed by hand or accepted from a claim —
 * into its slot. A locked value is refused. A MANUAL or VERIFIED value that
 * disagrees is replaced only with an explicit override, so accepting evidence
 * never silently overwrites what someone decided. A value the listing's
 * columns can show stays mirrored and is written back; one they cannot stops
 * mirroring. The caller has begun the product change and finishes it.
 */
export async function writeDecidedFact(tx: Executor, input: DecidedFactWrite): Promise<{ row: FactRow; existing: FactRow | undefined }> {
  const [existing]: FactRow[] = await tx
    .select()
    .from(pkbFacts)
    .where(
      and(
        eq(pkbFacts.pkbProductId, input.pkbProductId),
        input.pkbVariantId ? eq(pkbFacts.pkbVariantId, input.pkbVariantId) : isNull(pkbFacts.pkbVariantId),
        eq(pkbFacts.definitionId, input.definition.id),
        eq(pkbFacts.ordinal, input.ordinal),
      ),
    );
  if (existing?.lockedAt) throw new PkbLockedError(input.definition.label);
  if (
    existing &&
    !input.overrideDecided &&
    (existing.verificationState === "MANUAL" || existing.verificationState === "VERIFIED") &&
    !sameStoredValue(existing, input.value)
  ) {
    throw new PkbError(
      `${input.definition.label} already has a ${existing.verificationState === "MANUAL" ? "value entered by staff" : "verified value"} (${existing.rawValue ?? "not applicable"}). Confirm replacing it.`,
      409,
      { decidedValue: input.definition.key },
    );
  }

  let legacyRef: string | null = null;
  if (input.value.valueStatus !== "not_applicable" && !input.pkbVariantId) {
    if (existing?.legacyRef) {
      legacyRef = isProjectable(existing.legacyRef) ? existing.legacyRef : null;
    } else if (!existing) {
      legacyRef = await projectableRefFor(tx, input.definition, input.listings);
    }
  }

  const value = input.value;
  const row = existing
    ? await updateFact(
        tx,
        existing,
        {
          valueStatus: value.valueStatus,
          rawValue: value.rawValue,
          rawUnit: value.rawUnit,
          valueText: value.typed.text,
          valueNumber: value.typed.number,
          valueNumberMax: value.typed.numberMax,
          valueUnit: value.typed.unit,
          valueBoolean: value.typed.boolean,
          valueDate: value.typed.date,
          valueOptionId: value.typed.optionId,
          valueBrandId: value.brandId,
          ...input.provenance,
          legacyRef,
        },
        { actorId: input.actorId, reason: input.reason },
      )
    : await insertFact(
        tx,
        { pkbProductId: input.pkbProductId, pkbVariantId: input.pkbVariantId, definitionId: input.definition.id, ordinal: input.ordinal },
        value,
        input.provenance,
        { legacyRef, actorId: input.actorId, reason: input.reason },
      );
  return { row, existing };
}

async function listingsOf(executor: Executor, pkbProductId: string): Promise<string[]> {
  const rows: { id: string }[] = await executor
    .select({ id: products.id })
    .from(products)
    .where(eq(products.pkbProductId, pkbProductId))
    .orderBy(products.id);
  return rows.map((row) => row.id);
}

/** Locks every listing of a knowledge product, in id order, and settles waiting changes. */
export async function beginProductChange(executor: Executor, pkbProductId: string): Promise<string[]> {
  const listings = await listingsOf(executor, pkbProductId);
  for (const id of listings) await beginListingChange(executor, id);
  return listings;
}

/** After a knowledge-native write: legacy columns follow, and the mirror agrees. */
export async function finishProductChange(executor: Executor, actorId: string, listings: string[], pkbProductId: string) {
  for (const id of listings) {
    const { changed } = await applyProjection(executor, id, pkbProductId);
    if (changed) {
      await recordAudit(
        { actorUserId: actorId, action: "product.updated", entityType: "product", entityId: id, after: { fromKnowledgeBase: true } },
        executor,
      );
    }
    await syncListingKnowledge(executor, id, staffChange(actorId));
  }
}

export type SetFactInput = {
  pkbProductId: string;
  pkbVariantId?: string | null;
  definitionId: string;
  ordinal?: number;
  /** The value as written, with its unit if any. Omit with `notApplicable`. */
  raw?: string;
  /** "Does not apply to this product" — a value, unlike unknown. */
  notApplicable?: boolean;
};

/**
 * Sets a value by hand: MANUAL, attributed to the staff member. A locked value
 * is refused. A value mirrored from a column the knowledge base cannot write
 * back (a specification-table row, a variant option) stops being mirrored, so
 * the table can no longer overwrite it.
 */
export async function setFact(actor: SessionUser | null, input: SetFactInput): Promise<FactRow> {
  const staff = requirePermission(actor, "catalog.manage");
  const ordinal = input.ordinal ?? 0;
  if (!input.notApplicable && !input.raw?.trim()) {
    throw new PkbError("Enter a value, or mark it as not applicable. Clearing a value is a separate action.");
  }

  return db.transaction(async (tx) => {
    const [product] = await tx.select().from(pkbProducts).where(eq(pkbProducts.id, input.pkbProductId));
    if (!product) throw new PkbError("That product is not in the knowledge base.", 404);
    if (input.pkbVariantId) {
      const [variant] = await tx
        .select()
        .from(pkbVariants)
        .where(and(eq(pkbVariants.id, input.pkbVariantId), eq(pkbVariants.pkbProductId, product.id)));
      if (!variant) throw new PkbError("That variant does not belong to this product.", 404);
    }
    const [definition] = await loadDefinitions(tx, [input.definitionId]);
    if (!definition) throw new PkbError("That attribute does not exist.", 404);
    if (definition.status === "retired") throw new PkbError(`${definition.label} is retired.`, 409);

    const listings = await beginProductChange(tx, product.id);

    const value: FactValue = input.notApplicable ? notApplicableValue() : readValue(definition, input.raw!);
    if (value.valueStatus === "normalized" && value.typed.brandName) {
      value.brandId = await ensureBrand(tx, value.typed.brandName, staffChange(staff.id));
      value.typed = { ...value.typed, brandName: null };
    }

    const sourceId = await createStaffEntrySource(tx, staff.id, "Entered in the knowledge base");
    const { row, existing } = await writeDecidedFact(tx, {
      pkbProductId: product.id,
      pkbVariantId: input.pkbVariantId ?? null,
      definition,
      ordinal,
      value,
      provenance: { verificationState: "MANUAL", origin: "MANUAL_ADMIN", sourceId, claimId: null, decidedBy: staff.id, decisionPolicy: null },
      listings,
      actorId: staff.id,
      reason: "Set by hand in the knowledge base.",
      // Typing a value by hand is itself the decision to replace what was there.
      overrideDecided: true,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.fact_set",
        entityType: "pkb_product",
        entityId: product.id,
        before: existing ? { rawValue: existing.rawValue, state: existing.verificationState } : undefined,
        after: { definition: definition.key, rawValue: row.rawValue, valueStatus: row.valueStatus },
      },
      tx,
    );
    await finishProductChange(tx, staff.id, listings, product.id);
    return row;
  });
}

/**
 * The legacy column a knowledge-native value should be written back to, so a
 * listing keeps showing it. Only where every listing of the product can take
 * it: a category specification is written only into listings filed under it.
 */
async function projectableRefFor(
  executor: Executor,
  definition: DefinitionRecord,
  listings: string[],
): Promise<string | null> {
  if (listings.length === 0) return null;
  if (definition.key === "brand") return "products.brand";
  if (definition.key === "country_of_origin") return "products.compliance.countryOfOrigin";
  if (definition.key === "box_contents") return "products.box_contents";
  const detailKey = Object.entries(LEGACY_DETAIL_DEFINITIONS).find(([, key]) => key === definition.key)?.[0];
  if (detailKey && definition.isSystem) return `products.details.${detailKey}`;

  const rows = await queryRows<{ category_attribute_id: string; covers_all: boolean }>(
    executor,
    sql`select m.category_attribute_id,
               bool_and(exists (
                 with recursive up as (
                   select c.id, c.parent_id, 0 as depth from categories c where c.id = p.category_id
                   union all
                   select c.id, c.parent_id, up.depth + 1 from categories c join up on c.id = up.parent_id where up.depth < 16
                 )
                 select 1 from up where up.id = ca.category_id
               )) as covers_all
        from pkb_legacy_attribute_map m
        join category_attributes ca on ca.id = m.category_attribute_id
        cross join products p
        where m.definition_id = ${definition.id}
          and p.id = any(${`{${listings.join(",")}}`}::uuid[])
        group by m.category_attribute_id`,
  );
  const usable = rows.filter((row) => row.covers_all);
  return usable.length === 1 ? `products.attribute_values.${usable[0].category_attribute_id}` : null;
}

async function loadFactForChange(tx: Executor, factId: string) {
  const [fact] = await tx.select().from(pkbFacts).where(eq(pkbFacts.id, factId));
  if (!fact) throw new PkbError("That value no longer exists.", 404);
  const listings = await beginProductChange(tx, fact.pkbProductId);
  // Re-read under the lock: the settle step may have changed it.
  const [current] = await tx.select().from(pkbFacts).where(eq(pkbFacts.id, factId));
  if (!current) throw new PkbError("That value no longer exists.", 404);
  const [definition] = await loadDefinitions(tx, [current.definitionId]);
  return { fact: current as FactRow, listings, definition: definition as DefinitionRecord };
}

/** Clears a value back to unknown. Refused while locked. */
export async function clearFact(actor: SessionUser | null, factId: string): Promise<void> {
  const staff = requirePermission(actor, "catalog.manage");
  await db.transaction(async (tx) => {
    const { fact, listings, definition } = await loadFactForChange(tx, factId);
    if (fact.lockedAt) throw new PkbLockedError(definition.label);
    await deleteFact(tx, fact, { actorId: staff.id, reason: "Cleared by hand in the knowledge base." });
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.fact_cleared",
        entityType: "pkb_product",
        entityId: fact.pkbProductId,
        before: { definition: definition.key, rawValue: fact.rawValue, state: fact.verificationState },
      },
      tx,
    );
    await finishProductChange(tx, staff.id, listings, fact.pkbProductId);
  });
}

async function setLock(actor: SessionUser | null, factId: string, lock: boolean): Promise<FactRow> {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const { fact, definition } = await loadFactForChange(tx, factId);
    if (Boolean(fact.lockedAt) === lock) return fact;
    const row = await updateFact(
      tx,
      fact,
      lock ? { lockedAt: new Date(), lockedBy: staff.id } : { lockedAt: null, lockedBy: null },
      {
        actorId: staff.id,
        reason: lock ? "Locked: automated changes may not overwrite it." : "Unlocked.",
        kind: lock ? "locked" : "unlocked",
      },
    );
    await recordAudit(
      {
        actorUserId: staff.id,
        action: lock ? "knowledge.fact_locked" : "knowledge.fact_unlocked",
        entityType: "pkb_product",
        entityId: fact.pkbProductId,
        after: { definition: definition.key },
      },
      tx,
    );
    return row;
  });
}

/** Locks a value: no automated path may change it, and a staff save through the old editor is refused. */
export function lockFact(actor: SessionUser | null, factId: string) {
  return setLock(actor, factId, true);
}

export function unlockFact(actor: SessionUser | null, factId: string) {
  return setLock(actor, factId, false);
}

// ------------------------------------------------------------------ reading

export type SlotView = {
  definition: DefinitionRecord;
  requirement: "required" | "recommended" | "optional" | null;
  variantDefining: boolean;
  /** Null for a product-level slot. */
  pkbVariantId: string | null;
  state: SlotState;
  facts: FactRow[];
  openClaims: number;
};

export type ProductKnowledgeView = {
  pkbProductId: string;
  familyId: string | null;
  familyAssignment: string;
  /** Slots the family schema asks for, per variant where variant-defining. */
  schemaSlots: SlotView[];
  /** Values stored for attributes the family does not list. */
  productOnlySlots: SlotView[];
  completeness: Completeness;
};

export type Completeness = {
  verified: number;
  manual: number;
  unverified: number;
  legacy: number;
  locked: number;
  suggested: number;
  conflict: number;
  notApplicable: number;
  missingRequired: number;
  missingRecommended: number;
  missingOptional: number;
};

function slotStateOf(facts: FactRow[], claims: (typeof pkbClaims.$inferSelect)[]): SlotState {
  if (claims.some((claim) => claim.status === "CONFLICT")) return "CONFLICT";
  if (facts.length > 0) return effectiveFactState(facts[0]);
  if (claims.length > 0) return "SUGGESTED";
  return "UNKNOWN";
}

/**
 * A product's knowledge measured against its family: one slot per schema
 * attribute (per variant for variant-defining ones), plus product-only values.
 * Missing means no value and no proposal — never counted as false or zero.
 */
export async function getProductKnowledge(
  executor: Executor,
  pkbProductId: string,
): Promise<ProductKnowledgeView | null> {
  const [product] = await executor.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
  if (!product) return null;

  const [facts, claims, variants]: [
    FactRow[],
    (typeof pkbClaims.$inferSelect)[],
    { id: string }[],
  ] = await Promise.all([
    executor.select().from(pkbFacts).where(eq(pkbFacts.pkbProductId, pkbProductId)),
    executor
      .select()
      .from(pkbClaims)
      .where(
        and(
          eq(pkbClaims.pkbProductId, pkbProductId),
          eq(pkbClaims.targetKind, "fact"),
          inArray(pkbClaims.status, ["SUGGESTED", "CONFLICT"]),
        ),
      ),
    executor.select({ id: pkbVariants.id }).from(pkbVariants).where(eq(pkbVariants.pkbProductId, pkbProductId)),
  ]);

  const schema: FamilySchemaAttribute[] = product.familyId ? await resolveFamilySchema(executor, product.familyId) : [];
  const schemaIds = new Set(schema.map((entry) => entry.definition.id));
  const definitions = new Map(
    (await loadDefinitions(executor, [...new Set(facts.map((fact) => fact.definitionId))])).map((row) => [row.id, row]),
  );

  const factsBy = new Map<string, FactRow[]>();
  for (const fact of facts) {
    const key = `${fact.pkbVariantId ?? "-"}|${fact.definitionId}`;
    factsBy.set(key, [...(factsBy.get(key) ?? []), fact].sort((a, b) => a.ordinal - b.ordinal));
  }
  const claimsBy = new Map<string, (typeof pkbClaims.$inferSelect)[]>();
  for (const claim of claims) {
    const key = `${claim.pkbVariantId ?? "-"}|${claim.definitionId}`;
    claimsBy.set(key, [...(claimsBy.get(key) ?? []), claim]);
  }

  const view = (definition: DefinitionRecord, pkbVariantId: string | null, entry: FamilySchemaAttribute | null): SlotView => {
    const key = `${pkbVariantId ?? "-"}|${definition.id}`;
    const slotFacts = factsBy.get(key) ?? [];
    const slotClaims = claimsBy.get(key) ?? [];
    return {
      definition,
      requirement: entry?.requirement ?? null,
      variantDefining: entry?.variantDefining ?? false,
      pkbVariantId,
      state: slotStateOf(slotFacts, slotClaims),
      facts: slotFacts,
      openClaims: slotClaims.length,
    };
  };

  const schemaSlots: SlotView[] = [];
  for (const entry of schema) {
    if (entry.variantDefining && variants.length > 0) {
      for (const variant of variants) schemaSlots.push(view(entry.definition, variant.id, entry));
    } else {
      schemaSlots.push(view(entry.definition, null, entry));
    }
  }

  const productOnlyKeys = new Set<string>();
  const productOnlySlots: SlotView[] = [];
  for (const fact of facts) {
    if (schemaIds.has(fact.definitionId)) continue;
    const key = `${fact.pkbVariantId ?? "-"}|${fact.definitionId}`;
    if (productOnlyKeys.has(key)) continue;
    productOnlyKeys.add(key);
    productOnlySlots.push(view(definitions.get(fact.definitionId)!, fact.pkbVariantId, null));
  }

  return {
    pkbProductId,
    familyId: product.familyId,
    familyAssignment: product.familyAssignment,
    schemaSlots,
    productOnlySlots,
    completeness: completenessOf(schemaSlots),
  };
}

export function completenessOf(slots: Pick<SlotView, "state" | "requirement">[]): Completeness {
  const counts: Completeness = {
    verified: 0,
    manual: 0,
    unverified: 0,
    legacy: 0,
    locked: 0,
    suggested: 0,
    conflict: 0,
    notApplicable: 0,
    missingRequired: 0,
    missingRecommended: 0,
    missingOptional: 0,
  };
  for (const slot of slots) {
    switch (slot.state) {
      case "VERIFIED": counts.verified++; break;
      case "MANUAL": counts.manual++; break;
      case "UNVERIFIED": counts.unverified++; break;
      case "LEGACY": counts.legacy++; break;
      case "LOCKED": counts.locked++; break;
      case "SUGGESTED": counts.suggested++; break;
      case "CONFLICT": counts.conflict++; break;
      case "NOT_APPLICABLE": counts.notApplicable++; break;
      case "UNKNOWN":
        if (slot.requirement === "required") counts.missingRequired++;
        else if (slot.requirement === "recommended") counts.missingRecommended++;
        else counts.missingOptional++;
        break;
    }
  }
  return counts;
}

export { lockListingKnowledge, slotKey };
