import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  attributes,
  attributeValues,
  categories,
  categoryAttributes,
  pkbFacts,
  pkbFamilies,
  pkbIdentifiers,
  pkbLegacyAttributeMap,
  pkbProducts,
  pkbSyncQueue,
  pkbUnmappedValues,
  pkbVariants,
  products,
  productVariants,
  variantOptionValues,
  type PkbUnmappedReason,
} from "@/db/schema";
import { logEvent } from "@/lib/observability/log";
import {
  lockListingKnowledge,
  PkbLockedError,
  queryRows,
  type Attribution,
  type Executor,
} from "./common";
import { LEGACY_IDENTIFIER_TYPES, normalizeIdentifier, type IdentifierInputType } from "./identifiers";
import { cleanText, labelKey } from "./normalize";
import { applyProjection, isProjectable } from "./projection";
import {
  createStaffEntrySource,
  deleteFact,
  ensureBrand,
  findBrandId,
  insertFact,
  pruneUnusedBrands,
  readValue,
  sameStoredValue,
  slotKey,
  updateFact,
  type FactRow,
  type FactValue,
  type Provenance,
} from "./store";
import {
  ensureSystemVocabulary,
  LEGACY_DETAIL_DEFINITIONS,
  LEGACY_DETAIL_IDENTIFIERS,
  loadDefinitions,
  matchDefinitionByLabel,
  type DefinitionRecord,
} from "./vocabulary";

/**
 * The legacy mirror (D-069 step 3, D-070).
 *
 * Until the editor writes to the knowledge base directly, a listing's legacy
 * columns are where staff type product facts. This module reads them and makes
 * the knowledge base agree, one listing at a time, attributing each change:
 *
 *  - a value is stored with its raw text, normalized form, source and state;
 *  - a value keeps its state while its raw text is unchanged, so saving a
 *    panel without editing it never turns a LEGACY value into MANUAL;
 *  - a locked value is never overwritten: a staff save that tries is refused,
 *    and an unattributed change is reverted from the knowledge base;
 *  - an unattributed change never overwrites a value a person or evidence
 *    decided — the knowledge base's value is written back instead;
 *  - anything that cannot be placed without guessing goes to
 *    `pkb_unmapped_values`.
 *
 * Idempotent: a second run with nothing changed writes nothing.
 */

type DesiredFact = {
  pkbVariantId: string | null;
  definition: DefinitionRecord;
  ordinal: number;
  raw: string;
  rawLabel: string | null;
  legacyRef: string;
  defaultUnit: string | null;
};

type DesiredIdentifier = {
  inputType: IdentifierInputType;
  raw: string;
  legacyRef: string;
};

type UnmappedEntry = {
  variantId: string | null;
  legacyRef: string;
  label: string | null;
  value: string;
  reason: PkbUnmappedReason;
};

export type SyncReport = {
  listingId: string;
  pkbProductId: string | null;
  created: number;
  updated: number;
  cleared: number;
  unchanged: number;
  restored: boolean;
  unmapped: number;
};

function entryKey(entry: UnmappedEntry): string {
  return createHash("sha256")
    .update(JSON.stringify([entry.variantId, entry.legacyRef, labelKey(entry.label ?? ""), cleanText(entry.value), entry.reason]))
    .digest("hex")
    .slice(0, 40);
}

function stringOf(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = cleanText(String(value));
  return text || null;
}

function rowsOf(value: unknown): { label: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const label = stringOf((row as { label?: unknown })?.label);
    const text = stringOf((row as { value?: unknown })?.value);
    return label && text ? [{ label, value: text }] : [];
  });
}

/** Whether this listing has an unprocessed legacy change waiting. */
export async function isListingQueued(executor: Executor, listingId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: pkbSyncQueue.productId })
    .from(pkbSyncQueue)
    .where(eq(pkbSyncQueue.productId, listingId));
  return Boolean(row);
}

/**
 * Takes the listing's knowledge lock and settles any change another path left
 * waiting, as unattributed, so the staff save that follows is credited only
 * with what it changes. Call at the start of a staff transaction that writes a
 * listing's legacy fact columns, variants or options.
 */
export async function beginListingChange(executor: Executor, listingId: string): Promise<void> {
  await lockListingKnowledge(executor, listingId);
  if (await isListingQueued(executor, listingId)) {
    await syncListingKnowledge(executor, listingId, { kind: "legacy" });
  }
}

export async function syncListingKnowledge(
  executor: Executor,
  listingId: string,
  attribution: Attribution,
  options: { dequeueIfQueuedAt?: string } = {},
): Promise<SyncReport> {
  await lockListingKnowledge(executor, listingId);
  const { legacySourceId } = await ensureSystemVocabulary(executor);
  const report: SyncReport = {
    listingId,
    pkbProductId: null,
    created: 0,
    updated: 0,
    cleared: 0,
    unchanged: 0,
    restored: false,
    unmapped: 0,
  };

  const [listing] = await executor.select().from(products).where(eq(products.id, listingId));
  if (!listing) {
    await dequeue(executor, listingId, options);
    return report;
  }
  const actorId = attribution.kind === "legacy" ? null : attribution.actorId;

  // 1. The knowledge product this listing sells.
  let pkbProduct: typeof pkbProducts.$inferSelect | undefined;
  if (listing.pkbProductId) {
    [pkbProduct] = await executor.select().from(pkbProducts).where(eq(pkbProducts.id, listing.pkbProductId));
  }
  if (!pkbProduct) {
    [pkbProduct] = await executor
      .insert(pkbProducts)
      .values({
        name: listing.title,
        origin: attribution.kind === "legacy" ? "UNKNOWN_LEGACY" : "MANUAL_ADMIN",
        createdBy: actorId,
      })
      .returning();
    // Not a change to the listing: no updated_at, and no trigger watches it.
    await executor.update(products).set({ pkbProductId: pkbProduct!.id }).where(eq(products.id, listingId));
  }
  const pkbProductId = pkbProduct!.id;
  report.pkbProductId = pkbProductId;

  if (pkbProduct!.nameSource === "listing_title" && pkbProduct!.name !== listing.title) {
    await executor.update(pkbProducts).set({ name: listing.title, updatedAt: new Date() }).where(eq(pkbProducts.id, pkbProductId));
  }

  // 2. Family: follows the listing's category unless someone chose one.
  if (pkbProduct!.familyAssignmentSource === null || pkbProduct!.familyAssignmentSource === "legacy_category") {
    const [category] = await executor
      .select({ familyId: categories.defaultFamilyId, status: pkbFamilies.status })
      .from(categories)
      .leftJoin(pkbFamilies, eq(pkbFamilies.id, categories.defaultFamilyId))
      .where(eq(categories.id, listing.categoryId));
    const familyId = category?.familyId && category.status === "approved" ? category.familyId : null;
    if ((pkbProduct!.familyId ?? null) !== familyId) {
      await executor
        .update(pkbProducts)
        .set(
          familyId
            ? { familyId, familyAssignment: "assigned", familyAssignmentSource: "legacy_category", updatedAt: new Date() }
            : { familyId: null, familyAssignment: "unassigned", familyAssignmentSource: null, updatedAt: new Date() },
        )
        .where(eq(pkbProducts.id, pkbProductId));
    }
  }

  // 3. Variant identities for the listing's offers.
  const offers: { id: string; pkbVariantId: string | null; variantProductId: string | null }[] = await executor
    .select({ id: productVariants.id, pkbVariantId: productVariants.pkbVariantId, variantProductId: pkbVariants.pkbProductId })
    .from(productVariants)
    .leftJoin(pkbVariants, eq(pkbVariants.id, productVariants.pkbVariantId))
    .where(eq(productVariants.productId, listingId));
  const variantByOffer = new Map<string, string>();
  for (const offer of offers) {
    if (offer.pkbVariantId && offer.variantProductId === pkbProductId) {
      variantByOffer.set(offer.id, offer.pkbVariantId);
      continue;
    }
    const [variant] = await executor
      .insert(pkbVariants)
      .values({ pkbProductId, origin: attribution.kind === "legacy" ? "UNKNOWN_LEGACY" : "MANUAL_ADMIN" })
      .returning({ id: pkbVariants.id });
    await executor.update(productVariants).set({ pkbVariantId: variant.id }).where(eq(productVariants.id, offer.id));
    variantByOffer.set(offer.id, variant.id);
  }

  // 4. What the legacy columns say.
  const definitions = await loadDefinitions(executor);
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const desired: DesiredFact[] = [];
  const desiredIdentifiers: DesiredIdentifier[] = [];
  const unmapped: UnmappedEntry[] = [];
  const taken = new Map<string, DesiredFact>();

  const want = (fact: DesiredFact) => {
    const key = slotKey({ pkbVariantId: fact.pkbVariantId, definitionId: fact.definition.id, ordinal: fact.ordinal });
    const existing = taken.get(key);
    if (existing) {
      const same = sameValue(readValue(existing.definition, existing.raw, existing), readValue(fact.definition, fact.raw, fact));
      unmapped.push({
        variantId: null,
        legacyRef: fact.legacyRef,
        label: fact.rawLabel ?? fact.definition.label,
        value: fact.raw,
        reason: same ? "duplicate_of_structured_value" : "conflicts_with_structured_value",
      });
      return;
    }
    taken.set(key, fact);
    desired.push(fact);
  };
  const productFact = (key: string, raw: string | null, legacyRef: string, ordinal = 0) => {
    const definition = byKey.get(key);
    if (!raw || !definition) return;
    want({ pkbVariantId: null, definition, ordinal, raw, rawLabel: null, legacyRef, defaultUnit: null });
  };

  productFact("brand", stringOf(listing.brand), "products.brand");

  const details = (listing.details as Record<string, unknown> | null) ?? {};
  for (const [key, value] of Object.entries(details)) {
    const raw = stringOf(value);
    if (!raw) continue;
    if (LEGACY_DETAIL_DEFINITIONS[key]) {
      productFact(LEGACY_DETAIL_DEFINITIONS[key], raw, `products.details.${key}`);
    } else if (LEGACY_DETAIL_IDENTIFIERS[key]) {
      desiredIdentifiers.push({ inputType: LEGACY_DETAIL_IDENTIFIERS[key], raw, legacyRef: `products.details.${key}` });
    } else {
      unmapped.push({ variantId: null, legacyRef: `products.details.${key}`, label: key, value: raw, reason: "no_matching_definition" });
    }
  }

  productFact(
    "country_of_origin",
    stringOf((listing.compliance as { countryOfOrigin?: unknown } | null)?.countryOfOrigin),
    "products.compliance.countryOfOrigin",
  );

  if (Array.isArray(listing.boxContents)) {
    let ordinal = 0;
    for (const entry of listing.boxContents as unknown[]) {
      const raw = stringOf(entry);
      if (raw) productFact("box_contents", raw, "products.box_contents", ordinal++);
    }
  }

  const identifierValue = stringOf(listing.identifierValue);
  if (listing.identifierType && identifierValue) {
    desiredIdentifiers.push({
      inputType: LEGACY_IDENTIFIER_TYPES[listing.identifierType] ?? "other",
      raw: identifierValue,
      legacyRef: `products.identifier.${listing.identifierType}`,
    });
  }

  const stored = (listing.attributeValues as Record<string, unknown> | null) ?? {};
  const attributeIds = Object.keys(stored);
  if (attributeIds.length > 0) {
    const [maps, legacyDefinitions]: [
      (typeof pkbLegacyAttributeMap.$inferSelect)[],
      { id: string; name: string; unit: string | null }[],
    ] = await Promise.all([
      executor.select().from(pkbLegacyAttributeMap).where(inArray(pkbLegacyAttributeMap.categoryAttributeId, attributeIds)),
      executor
        .select({ id: categoryAttributes.id, name: categoryAttributes.name, unit: categoryAttributes.unit })
        .from(categoryAttributes)
        .where(inArray(categoryAttributes.id, attributeIds)),
    ]);
    const definitionOf = new Map(maps.map((row) => [row.categoryAttributeId, byId.get(row.definitionId)]));
    const legacyOf = new Map(legacyDefinitions.map((row) => [row.id, row]));
    for (const id of attributeIds) {
      const definition = definitionOf.get(id);
      const values = (Array.isArray(stored[id]) ? (stored[id] as unknown[]) : [stored[id]])
        .map(stringOf)
        .filter((value): value is string => value !== null);
      const legacyRef = `products.attribute_values.${id}`;
      if (!definition) {
        for (const value of values) {
          unmapped.push({ variantId: null, legacyRef, label: legacyOf.get(id)?.name ?? null, value, reason: "no_matching_definition" });
        }
        continue;
      }
      const seen = new Set<string>();
      let ordinal = 0;
      for (const value of definition.cardinality === "multiple" ? values : values.slice(0, 1)) {
        if (seen.has(labelKey(value))) continue;
        seen.add(labelKey(value));
        want({
          pkbVariantId: null,
          definition,
          ordinal: definition.cardinality === "multiple" ? ordinal++ : 0,
          raw: value,
          rawLabel: null,
          legacyRef,
          defaultUnit: legacyOf.get(id)?.unit ?? null,
        });
      }
    }
  }

  // Hand-typed table rows map only by exact label; everything else waits for a person.
  for (const [column, rows] of [
    ["products.spec_table", rowsOf(listing.specTable)],
    ["products.measurements", rowsOf(listing.measurements)],
  ] as const) {
    for (const row of rows) {
      const match = matchDefinitionByLabel(definitions, row.label);
      if (match.kind === "none") {
        unmapped.push({ variantId: null, legacyRef: column, label: row.label, value: row.value, reason: "no_matching_definition" });
      } else if (match.kind === "ambiguous") {
        unmapped.push({ variantId: null, legacyRef: column, label: row.label, value: row.value, reason: "ambiguous_label" });
      } else if (match.definition.cardinality === "multiple") {
        unmapped.push({ variantId: null, legacyRef: column, label: row.label, value: row.value, reason: "multi_value_label" });
      } else {
        want({ pkbVariantId: null, definition: match.definition, ordinal: 0, raw: row.value, rawLabel: row.label, legacyRef: column, defaultUnit: null });
      }
    }
  }

  if (offers.length > 0) {
    const options: {
      variantId: string;
      attributeId: string;
      name: string;
      definitionId: string | null;
      value: string;
    }[] = await executor
      .select({
        variantId: variantOptionValues.variantId,
        attributeId: attributes.id,
        name: attributes.name,
        definitionId: attributes.attributeDefinitionId,
        value: attributeValues.value,
      })
      .from(variantOptionValues)
      .innerJoin(attributes, eq(attributes.id, variantOptionValues.attributeId))
      .innerJoin(attributeValues, eq(attributeValues.id, variantOptionValues.attributeValueId))
      .innerJoin(productVariants, eq(productVariants.id, variantOptionValues.variantId))
      .where(eq(productVariants.productId, listingId));

    const linked = new Map<string, DefinitionRecord | null>();
    for (const option of options) {
      if (!linked.has(option.attributeId)) {
        let definition = option.definitionId ? byId.get(option.definitionId) : undefined;
        if (!definition || definition.status === "retired") {
          const match = matchDefinitionByLabel(definitions, option.name);
          definition = match.kind === "match" ? match.definition : undefined;
          if (match.kind === "ambiguous") linked.set(option.attributeId, null);
          if ((definition?.id ?? null) !== option.definitionId) {
            await executor
              .update(attributes)
              .set({ attributeDefinitionId: definition?.id ?? null })
              .where(eq(attributes.id, option.attributeId));
          }
        }
        if (!linked.has(option.attributeId)) linked.set(option.attributeId, definition ?? null);
      }
      const definition = linked.get(option.attributeId);
      const legacyRef = `variant_option_values.${option.attributeId}`;
      const raw = stringOf(option.value);
      if (!raw) continue;
      if (!definition) {
        unmapped.push({ variantId: null, legacyRef, label: option.name, value: raw, reason: "option_without_definition" });
      } else if (definition.cardinality === "multiple") {
        unmapped.push({ variantId: null, legacyRef, label: option.name, value: raw, reason: "multi_value_label" });
      } else {
        want({
          pkbVariantId: variantByOffer.get(option.variantId)!,
          definition,
          ordinal: 0,
          raw,
          rawLabel: option.name,
          legacyRef,
          defaultUnit: null,
        });
      }
    }
  }

  // 5. Compare with what the knowledge base holds.
  const current: FactRow[] = await executor.select().from(pkbFacts).where(eq(pkbFacts.pkbProductId, pkbProductId));
  const currentBySlot = new Map(current.map((row) => [slotKey(row), row]));
  const desiredSlots = new Set(desired.map((fact) => slotKey({ ...fact, definitionId: fact.definition.id })));
  const removed = current.filter((row) => row.legacyRef !== null && !desiredSlots.has(slotKey(row)));
  const consumed = new Set<string>();
  const touchedBrands: string[] = [];
  let staffSourceId: string | null = null;
  let restore = false;

  const provenanceFor = async (): Promise<Provenance> => {
    if (attribution.kind === "legacy") {
      return { verificationState: "LEGACY", origin: "UNKNOWN_LEGACY", sourceId: legacySourceId, claimId: null, decidedBy: null, decisionPolicy: null };
    }
    staffSourceId ??= await createStaffEntrySource(
      executor,
      attribution.actorId,
      attribution.kind === "staff_copy" ? "Copied when a listing was duplicated" : "Product editor",
    );
    return attribution.kind === "staff"
      ? { verificationState: "MANUAL", origin: "MANUAL_ADMIN", sourceId: staffSourceId, claimId: null, decidedBy: attribution.actorId, decisionPolicy: null }
      : { verificationState: "UNVERIFIED", origin: "MANUAL_ADMIN", sourceId: staffSourceId, claimId: null, decidedBy: null, decisionPolicy: null };
  };

  const resolve = async (fact: DesiredFact, create: boolean): Promise<FactValue> => {
    const value = readValue(fact.definition, fact.raw, fact);
    if (value.valueStatus === "normalized" && value.typed.brandName) {
      value.brandId = create ? await ensureBrand(executor, value.typed.brandName, attribution) : await findBrandId(executor, value.typed.brandName);
      value.typed = { ...value.typed, brandName: null };
    }
    return value;
  };

  const refuseOrRevert = (row: FactRow, value: string, label: string) => {
    if (attribution.kind !== "legacy") throw new PkbLockedError(label);
    if (isProjectable(row.legacyRef)) restore = true;
    unmapped.push({ variantId: null, legacyRef: row.legacyRef!, label, value, reason: "differs_from_locked_value" });
  };

  const notApplied = (row: FactRow, value: string, label: string) => {
    if (isProjectable(row.legacyRef)) restore = true;
    unmapped.push({ variantId: null, legacyRef: row.legacyRef!, label, value, reason: "unattributed_change_not_applied" });
  };

  for (const fact of desired) {
    const slot = { pkbProductId, pkbVariantId: fact.pkbVariantId, definitionId: fact.definition.id, ordinal: fact.ordinal };
    const row = currentBySlot.get(slotKey(slot));
    const label = fact.rawLabel ?? fact.definition.label;

    if (row && row.legacyRef === null) {
      // The knowledge base owns this slot; the legacy value does not override it.
      const value = await resolve(fact, false);
      if (!sameStoredValue(row, value)) {
        unmapped.push({ variantId: null, legacyRef: fact.legacyRef, label, value: fact.raw, reason: "differs_from_knowledge_value" });
      }
      report.unchanged += 1;
      continue;
    }

    if (!row) {
      const value = await resolve(fact, true);
      // A value that moved slots (its definition was remapped) keeps its provenance.
      const moved = removed.find(
        (candidate) => !consumed.has(candidate.id) && candidate.legacyRef === fact.legacyRef && candidate.rawValue === value.rawValue,
      );
      if (moved) {
        consumed.add(moved.id);
        await deleteFact(executor, moved, { actorId, reason: "Moved to a new attribute definition." });
        await insertFact(
          executor,
          slot,
          value,
          {
            verificationState: moved.verificationState,
            origin: moved.origin,
            sourceId: moved.sourceId,
            claimId: moved.claimId,
            decidedBy: moved.decidedBy,
            decisionPolicy: moved.decisionPolicy,
          },
          {
            legacyRef: fact.legacyRef,
            actorId,
            reason: "Moved to a new attribute definition.",
            locked: moved.lockedAt ? { at: moved.lockedAt, by: moved.lockedBy! } : null,
          },
        );
      } else {
        await insertFact(executor, slot, value, await provenanceFor(), {
          legacyRef: fact.legacyRef,
          actorId,
          reason: reasonFor(attribution, "Recorded"),
        });
      }
      if (value.brandId) touchedBrands.push(value.brandId);
      report.created += 1;
      continue;
    }

    const rawValue = cleanText(fact.raw);
    if (row.rawValue === rawValue && row.legacyRef === fact.legacyRef) {
      const value = await resolve(fact, true);
      if (!sameStoredValue(row, value)) {
        // Same text, read differently (a definition or rule changed): provenance stays.
        await updateFact(executor, row, valueColumnsOf(value), { actorId, reason: "Normalized again." });
        report.updated += 1;
      } else {
        if ((row.rawLabel ?? null) !== fact.rawLabel) {
          await executor.update(pkbFacts).set({ rawLabel: fact.rawLabel }).where(eq(pkbFacts.id, row.id));
        }
        report.unchanged += 1;
      }
      continue;
    }

    if (row.lockedAt) {
      refuseOrRevert(row, rawValue, label);
      continue;
    }
    if (attribution.kind === "legacy" && row.verificationState !== "LEGACY") {
      notApplied(row, rawValue, label);
      continue;
    }
    const value = await resolve(fact, true);
    if (row.valueBrandId) touchedBrands.push(row.valueBrandId);
    await updateFact(
      executor,
      row,
      { ...valueColumnsOf(value), ...(await provenanceFor()), legacyRef: fact.legacyRef },
      { actorId, reason: reasonFor(attribution, "Changed") },
    );
    report.updated += 1;
  }

  for (const row of removed) {
    if (consumed.has(row.id)) continue;
    const label = row.rawLabel ?? byId.get(row.definitionId)?.label ?? "A value";
    if (row.lockedAt) {
      refuseOrRevert(row, row.rawValue ?? "", label);
      continue;
    }
    if (attribution.kind === "legacy" && row.verificationState !== "LEGACY") {
      notApplied(row, row.rawValue ?? "", label);
      continue;
    }
    if (row.valueBrandId) touchedBrands.push(row.valueBrandId);
    await deleteFact(executor, row, { actorId, reason: reasonFor(attribution, "Removed") });
    report.cleared += 1;
  }

  // 6. Identifiers.
  const identifierReport = await syncIdentifiers(executor, {
    pkbProductId,
    desired: desiredIdentifiers,
    attribution,
    provenanceFor,
    unmapped,
  });
  report.created += identifierReport.created;
  report.updated += identifierReport.updated;
  report.cleared += identifierReport.cleared;
  restore ||= identifierReport.restore;

  // 7. What could not be placed.
  report.unmapped = await syncUnmapped(executor, listingId, unmapped, offers.map((offer) => offer.id));

  // 8. Revert unattributed changes to decided values.
  if (restore) {
    const { changed } = await applyProjection(executor, listingId, pkbProductId);
    report.restored = changed;
    if (changed) {
      await logEvent("warn", "pkb.sync.reverted_unattributed_change", { listingId, pkbProductId });
    }
  }

  // 9. Variant identities no offer points at any more, holding nothing of their own.
  await executor.execute(sql`
    delete from pkb_variants v
    where v.pkb_product_id = ${pkbProductId}
      and not exists (select 1 from product_variants pv where pv.pkb_variant_id = v.id)
      and not exists (select 1 from pkb_facts f where f.pkb_variant_id = v.id and f.legacy_ref is null)
      and not exists (select 1 from pkb_identifiers i where i.pkb_variant_id = v.id and i.legacy_ref is null)
      and not exists (select 1 from pkb_claims c where c.pkb_variant_id = v.id)
      and not exists (select 1 from pkb_aliases a where a.pkb_variant_id = v.id)
  `);
  await pruneUnusedBrands(executor, touchedBrands);
  await dequeue(executor, listingId, options);
  return report;
}

function reasonFor(attribution: Attribution, verb: string): string {
  switch (attribution.kind) {
    case "staff":
      return `${verb} in the product editor.`;
    case "staff_copy":
      return `${verb} by duplicating a listing.`;
    default:
      return `${verb} from the listing's existing data (unattributed).`;
  }
}

function valueColumnsOf(value: FactValue) {
  return {
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
    rawLabel: value.rawLabel,
  };
}

function sameValue(a: FactValue, b: FactValue): boolean {
  return (
    a.valueStatus === b.valueStatus &&
    JSON.stringify(a.typed) === JSON.stringify(b.typed) &&
    (a.valueStatus !== "unnormalized" || a.rawValue === b.rawValue)
  );
}

async function dequeue(executor: Executor, listingId: string, options: { dequeueIfQueuedAt?: string }) {
  if (options.dequeueIfQueuedAt) {
    // Compared as text: a JavaScript Date would drop the microseconds, and a
    // row re-queued in the meantime must survive.
    await executor.execute(
      sql`delete from pkb_sync_queue where product_id = ${listingId} and queued_at::text = ${options.dequeueIfQueuedAt}`,
    );
  } else {
    await executor.delete(pkbSyncQueue).where(eq(pkbSyncQueue.productId, listingId));
  }
}

async function syncIdentifiers(
  executor: Executor,
  input: {
    pkbProductId: string;
    desired: DesiredIdentifier[];
    attribution: Attribution;
    provenanceFor: () => Promise<Provenance>;
    unmapped: UnmappedEntry[];
  },
): Promise<{ created: number; updated: number; cleared: number; restore: boolean }> {
  const { pkbProductId, attribution, unmapped } = input;
  const result = { created: 0, updated: 0, cleared: 0, restore: false };
  const current: (typeof pkbIdentifiers.$inferSelect)[] = await executor
    .select()
    .from(pkbIdentifiers)
    .where(eq(pkbIdentifiers.pkbProductId, pkbProductId));
  const mirrored = new Map(current.filter((row) => row.legacyRef).map((row) => [row.legacyRef!, row]));
  const native = current.filter((row) => !row.legacyRef);
  const wantedRefs = new Set<string>();
  const seen = new Set<string>();

  for (const want of input.desired) {
    const normalized = normalizeIdentifier(want.inputType, want.raw);
    const identity = `${normalized.type}|${normalized.normalized ?? normalized.raw}`;
    const label = want.legacyRef.split(".").at(-1) ?? "identifier";
    if (seen.has(identity) || native.some((row) => `${row.identifierType}|${row.valueNormalized ?? row.valueRaw}` === identity)) {
      continue;
    }
    seen.add(identity);
    if (normalized.validation === "invalid") {
      unmapped.push({ variantId: null, legacyRef: want.legacyRef, label, value: want.raw, reason: "invalid_identifier" });
    }
    if (normalized.gtin14) {
      const [owner] = await executor
        .select({ pkbProductId: pkbIdentifiers.pkbProductId })
        .from(pkbIdentifiers)
        .where(eq(pkbIdentifiers.gtin14, normalized.gtin14));
      if (owner && owner.pkbProductId !== pkbProductId) {
        unmapped.push({ variantId: null, legacyRef: want.legacyRef, label, value: want.raw, reason: "identifier_in_use" });
        continue;
      }
    }
    wantedRefs.add(want.legacyRef);
    const row = mirrored.get(want.legacyRef);
    const columns = {
      identifierType: normalized.type,
      valueRaw: normalized.raw,
      valueNormalized: normalized.normalized,
      gtin14: normalized.gtin14,
      validationStatus: normalized.validation,
    };
    if (!row) {
      await executor.insert(pkbIdentifiers).values({ pkbProductId, ...columns, ...(await input.provenanceFor()), legacyRef: want.legacyRef });
      result.created += 1;
      continue;
    }
    if (row.valueRaw === normalized.raw && row.identifierType === normalized.type) continue;
    if (row.lockedAt) {
      if (attribution.kind !== "legacy") throw new PkbLockedError("The trade identifier");
      result.restore = true;
      unmapped.push({ variantId: null, legacyRef: want.legacyRef, label, value: want.raw, reason: "differs_from_locked_value" });
      continue;
    }
    if (attribution.kind === "legacy" && row.verificationState !== "LEGACY") {
      result.restore = true;
      unmapped.push({ variantId: null, legacyRef: want.legacyRef, label, value: want.raw, reason: "unattributed_change_not_applied" });
      continue;
    }
    await executor
      .update(pkbIdentifiers)
      .set({ ...columns, ...(await input.provenanceFor()), updatedAt: new Date() })
      .where(eq(pkbIdentifiers.id, row.id));
    result.updated += 1;
  }

  for (const [ref, row] of mirrored) {
    if (wantedRefs.has(ref)) continue;
    if (row.lockedAt) {
      if (attribution.kind !== "legacy") throw new PkbLockedError("The trade identifier");
      result.restore = true;
      continue;
    }
    if (attribution.kind === "legacy" && row.verificationState !== "LEGACY") {
      result.restore = true;
      continue;
    }
    await executor.delete(pkbIdentifiers).where(eq(pkbIdentifiers.id, row.id));
    result.cleared += 1;
  }
  return result;
}

const EVENT_REASONS = new Set<PkbUnmappedReason>(["unattributed_change_not_applied", "differs_from_locked_value"]);

async function syncUnmapped(
  executor: Executor,
  listingId: string,
  entries: UnmappedEntry[],
  offerIds: string[],
): Promise<number> {
  const liveOffers = new Set(offerIds);
  const wanted = new Map<string, UnmappedEntry>();
  for (const entry of entries) {
    const normalized = { ...entry, variantId: entry.variantId && liveOffers.has(entry.variantId) ? entry.variantId : null };
    wanted.set(entryKey(normalized), normalized);
  }
  const existing: { id: string; entryKey: string; reason: PkbUnmappedReason }[] = await executor
    .select({ id: pkbUnmappedValues.id, entryKey: pkbUnmappedValues.entryKey, reason: pkbUnmappedValues.reason })
    .from(pkbUnmappedValues)
    .where(eq(pkbUnmappedValues.productId, listingId));
  const have = new Set(existing.map((row) => row.entryKey));

  // Most entries describe the legacy columns as they are now and go when the
  // value does. A refused change is an event: its record stays after the
  // column is written back, until a person dismisses it.
  const stale = existing
    .filter((row) => !wanted.has(row.entryKey) && !EVENT_REASONS.has(row.reason))
    .map((row) => row.id);
  if (stale.length > 0) await executor.delete(pkbUnmappedValues).where(inArray(pkbUnmappedValues.id, stale));

  const fresh = [...wanted.entries()].filter(([key]) => !have.has(key));
  if (fresh.length > 0) {
    await executor
      .insert(pkbUnmappedValues)
      .values(
        fresh.map(([key, entry]) => ({
          productId: listingId,
          variantId: entry.variantId,
          legacyRef: entry.legacyRef,
          label: entry.label?.slice(0, 200) ?? null,
          value: entry.value.slice(0, 4000),
          entryKey: key,
          reason: entry.reason,
        })),
      )
      .onConflictDoNothing();
  }
  return wanted.size;
}

// ------------------------------------------------------------------ queue

export type QueueReport = { processed: number; failed: number; remaining: number };

/**
 * Processes queued listings: the background half of the mirror, for changes no
 * staff transaction synced (imports, scripts, category moves). Each listing is
 * claimed in a short transaction and synced in its own, so a slow listing
 * never holds a lock another writer waits on.
 */
export async function processKnowledgeQueue(
  executor: Executor,
  options: { limit?: number; workerId?: string; timeBudgetMs?: number } = {},
): Promise<QueueReport> {
  const limit = options.limit ?? 200;
  const workerId = options.workerId ?? `pkb-${process.pid}`;
  const deadline = Date.now() + (options.timeBudgetMs ?? 50_000);
  const report: QueueReport = { processed: 0, failed: 0, remaining: 0 };

  const claimed = await queryRows<{ product_id: string; queued_at: string }>(
    executor,
    sql`update pkb_sync_queue q set claimed_at = now(), claimed_by = ${workerId}
        where q.product_id in (
          select product_id from pkb_sync_queue
          where claimed_at is null or claimed_at < now() - interval '10 minutes'
          order by queued_at
          limit ${limit}
          for update skip locked
        )
        returning q.product_id, q.queued_at::text as queued_at`,
  );

  for (const row of claimed) {
    if (Date.now() > deadline) break;
    try {
      await executor.transaction((tx: Executor) =>
        syncListingKnowledge(tx, row.product_id, { kind: "legacy" }, { dequeueIfQueuedAt: row.queued_at }),
      );
      report.processed += 1;
    } catch (error) {
      report.failed += 1;
      await logEvent("error", "pkb.sync.failed", { listingId: row.product_id, error });
      await executor
        .update(pkbSyncQueue)
        .set({
          attempts: sql`${pkbSyncQueue.attempts} + 1`,
          claimedAt: null,
          claimedBy: null,
          lastError: error instanceof Error ? error.message.slice(0, 500) : "Unknown error.",
        })
        .where(eq(pkbSyncQueue.productId, row.product_id))
        .catch(() => undefined);
    }
  }

  // Claimed but not reached before the deadline: give them back.
  await executor.execute(
    sql`update pkb_sync_queue set claimed_at = null, claimed_by = null where claimed_by = ${workerId}`,
  );
  const [{ n }] = await queryRows<{ n: number }>(executor, sql`select count(*)::int as n from pkb_sync_queue`);
  report.remaining = Number(n);
  return report;
}

/** Listings the mirror has placed nowhere yet. Used by the reconciliation report. */
export async function listingsWithoutKnowledge(executor: Executor): Promise<number> {
  const [{ n }] = await queryRows<{ n: number }>(
    executor,
    sql`select count(*)::int as n from products where pkb_product_id is null`,
  );
  return Number(n);
}

