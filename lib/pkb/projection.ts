import { and, eq, inArray, isNull } from "drizzle-orm";
import { pkbAttributeDefinitions, pkbFacts, pkbIdentifiers, pkbLegacyAttributeMap, products } from "@/db/schema";
import type { Executor } from "./common";
import { cleanText } from "./normalize";
import { LEGACY_DETAIL_DEFINITIONS, LEGACY_DETAIL_IDENTIFIERS } from "./vocabulary";

/**
 * Knowledge → legacy columns (D-069 step 3).
 *
 * While the listing editor and the storefront still read `products.brand`,
 * `details`, `attribute_values`, `box_contents`, the identifier columns and
 * the country of origin, a change made in the knowledge base is written back
 * into them here, so the two cannot disagree. The specification and
 * measurement tables and the variant options are not projected: their mirrored
 * values detach from the listing when changed in the knowledge base (D-070).
 */

export const PROJECTABLE_PREFIXES = [
  "products.brand",
  "products.details.",
  "products.attribute_values.",
  "products.box_contents",
  "products.compliance.countryOfOrigin",
  "products.identifier.",
] as const;

export function isProjectable(legacyRef: string | null): boolean {
  if (!legacyRef) return false;
  return PROJECTABLE_PREFIXES.some((prefix) =>
    prefix.endsWith(".") ? legacyRef.startsWith(prefix) : legacyRef === prefix,
  );
}

export type LegacyStructuredFields = {
  brand: string | null;
  identifierType: string | null;
  identifierValue: string | null;
  details: Record<string, string>;
  attributeValues: Record<string, string | string[]>;
  boxContents: string[];
  countryOfOrigin: string | null;
};

type MirroredValue = {
  legacyRef: string | null;
  ordinal: number;
  rawValue: string | null;
  multiple: boolean;
};

type MirroredIdentifier = { legacyRef: string | null; valueRaw: string };

/**
 * The structured legacy fields as the knowledge base holds them. Pure, so the
 * round trip legacy → knowledge → legacy can be checked for loss.
 */
export function projectLegacyFields(facts: MirroredValue[], identifiers: MirroredIdentifier[]): LegacyStructuredFields {
  const fields: LegacyStructuredFields = {
    brand: null,
    identifierType: null,
    identifierValue: null,
    details: {},
    attributeValues: {},
    boxContents: [],
    countryOfOrigin: null,
  };
  const multi = new Map<string, { ordinal: number; value: string }[]>();

  for (const fact of [...facts].sort((a, b) => a.ordinal - b.ordinal)) {
    const ref = fact.legacyRef;
    const raw = fact.rawValue;
    if (!ref || raw === null) continue;
    if (ref === "products.brand") fields.brand = raw;
    else if (ref === "products.compliance.countryOfOrigin") fields.countryOfOrigin = raw;
    else if (ref === "products.box_contents") fields.boxContents.push(raw);
    else if (ref.startsWith("products.details.")) fields.details[ref.slice("products.details.".length)] = raw;
    else if (ref.startsWith("products.attribute_values.")) {
      const id = ref.slice("products.attribute_values.".length);
      if (fact.multiple) {
        multi.set(id, [...(multi.get(id) ?? []), { ordinal: fact.ordinal, value: raw }]);
      } else {
        fields.attributeValues[id] = raw;
      }
    }
  }
  for (const [id, values] of multi) fields.attributeValues[id] = values.map((entry) => entry.value);

  for (const identifier of identifiers) {
    const ref = identifier.legacyRef;
    if (!ref) continue;
    if (ref.startsWith("products.identifier.")) {
      fields.identifierType = ref.slice("products.identifier.".length);
      fields.identifierValue = identifier.valueRaw;
    } else if (ref.startsWith("products.details.")) {
      fields.details[ref.slice("products.details.".length)] = identifier.valueRaw;
    }
  }
  return fields;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = cleanText(String(value));
  return text || null;
}

/** The same fields read straight from a listing row, cleaned the way the knowledge base stores text. */
export function legacyStructuredFields(listing: {
  brand: string | null;
  identifierType: string | null;
  identifierValue: string | null;
  details: unknown;
  attributeValues: unknown;
  boxContents: unknown;
  compliance: unknown;
}): LegacyStructuredFields {
  const details: Record<string, string> = {};
  if (listing.details && typeof listing.details === "object") {
    for (const [key, value] of Object.entries(listing.details as Record<string, unknown>)) {
      const text = textOrNull(value);
      if (text) details[key] = text;
    }
  }
  const attributeValues: Record<string, string | string[]> = {};
  if (listing.attributeValues && typeof listing.attributeValues === "object") {
    for (const [key, value] of Object.entries(listing.attributeValues as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const list = value.map(textOrNull).filter((entry): entry is string => entry !== null);
        if (list.length > 0) attributeValues[key] = list;
      } else {
        const text = textOrNull(value);
        if (text) attributeValues[key] = text;
      }
    }
  }
  const identifierValue = textOrNull(listing.identifierValue);
  return {
    brand: textOrNull(listing.brand),
    identifierType: identifierValue ? listing.identifierType : null,
    identifierValue: listing.identifierType ? identifierValue : null,
    details,
    attributeValues,
    boxContents: Array.isArray(listing.boxContents)
      ? (listing.boxContents as unknown[]).map(textOrNull).filter((entry): entry is string => entry !== null)
      : [],
    countryOfOrigin: textOrNull((listing.compliance as { countryOfOrigin?: unknown } | null)?.countryOfOrigin),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sameStructuredFields(a: LegacyStructuredFields, b: LegacyStructuredFields): boolean {
  return canonical(a) === canonical(b);
}

/** Loads the mirrored values of one knowledge product and projects them. */
export async function loadProjection(executor: Executor, pkbProductId: string): Promise<LegacyStructuredFields> {
  const [facts, identifiers] = await Promise.all([
    executor
      .select({
        legacyRef: pkbFacts.legacyRef,
        ordinal: pkbFacts.ordinal,
        rawValue: pkbFacts.rawValue,
        cardinality: pkbAttributeDefinitions.cardinality,
      })
      .from(pkbFacts)
      .innerJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbFacts.definitionId))
      .where(and(eq(pkbFacts.pkbProductId, pkbProductId), isNull(pkbFacts.pkbVariantId))),
    executor
      .select({ legacyRef: pkbIdentifiers.legacyRef, valueRaw: pkbIdentifiers.valueRaw })
      .from(pkbIdentifiers)
      .where(eq(pkbIdentifiers.pkbProductId, pkbProductId)),
  ]);
  return projectLegacyFields(
    facts.map((fact: { legacyRef: string | null; ordinal: number; rawValue: string | null; cardinality: string }) => ({
      legacyRef: fact.legacyRef,
      ordinal: fact.ordinal,
      rawValue: fact.rawValue,
      multiple: fact.cardinality === "multiple",
    })),
    identifiers,
  );
}

/**
 * The same projection for many knowledge products at once.
 *
 * The reconciliation report compares every listing with its knowledge, and
 * doing that one product at a time cost two statements per listing — 10,000 of
 * them on the 5,000-listing scale database, and 2.4 seconds of the report
 * (risk R-2). This reads one chunk of products in two statements instead. The
 * projection itself is the same function; only the fetching is batched.
 */
export async function loadProjections(
  executor: Executor,
  pkbProductIds: string[],
): Promise<Map<string, LegacyStructuredFields>> {
  const result = new Map<string, LegacyStructuredFields>();
  if (pkbProductIds.length === 0) return result;

  const [facts, identifiers]: [
    { pkbProductId: string; legacyRef: string | null; ordinal: number; rawValue: string | null; cardinality: string }[],
    { pkbProductId: string; legacyRef: string | null; valueRaw: string }[],
  ] = await Promise.all([
    executor
      .select({
        pkbProductId: pkbFacts.pkbProductId,
        legacyRef: pkbFacts.legacyRef,
        ordinal: pkbFacts.ordinal,
        rawValue: pkbFacts.rawValue,
        cardinality: pkbAttributeDefinitions.cardinality,
      })
      .from(pkbFacts)
      .innerJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbFacts.definitionId))
      .where(and(inArray(pkbFacts.pkbProductId, pkbProductIds), isNull(pkbFacts.pkbVariantId))),
    executor
      .select({
        pkbProductId: pkbIdentifiers.pkbProductId,
        legacyRef: pkbIdentifiers.legacyRef,
        valueRaw: pkbIdentifiers.valueRaw,
      })
      .from(pkbIdentifiers)
      .where(inArray(pkbIdentifiers.pkbProductId, pkbProductIds)),
  ]);

  const factsBy = new Map<string, { legacyRef: string | null; ordinal: number; rawValue: string | null; multiple: boolean }[]>();
  for (const fact of facts) {
    const entry = { legacyRef: fact.legacyRef, ordinal: fact.ordinal, rawValue: fact.rawValue, multiple: fact.cardinality === "multiple" };
    const list = factsBy.get(fact.pkbProductId);
    if (list) list.push(entry);
    else factsBy.set(fact.pkbProductId, [entry]);
  }
  const identifiersBy = new Map<string, MirroredIdentifier[]>();
  for (const identifier of identifiers) {
    const entry = { legacyRef: identifier.legacyRef, valueRaw: identifier.valueRaw };
    const list = identifiersBy.get(identifier.pkbProductId);
    if (list) list.push(entry);
    else identifiersBy.set(identifier.pkbProductId, [entry]);
  }

  for (const id of pkbProductIds) {
    result.set(id, projectLegacyFields(factsBy.get(id) ?? [], identifiersBy.get(id) ?? []));
  }
  return result;
}

/**
 * Writes a knowledge product's mirrored values back into its listing's legacy
 * columns, when they differ. Legacy keys the knowledge base does not mirror
 * (an unknown details key, a specification with no definition yet) are kept.
 */
export async function applyProjection(
  executor: Executor,
  listingId: string,
  pkbProductId: string,
): Promise<{ changed: boolean }> {
  const [listing] = await executor.select().from(products).where(eq(products.id, listingId));
  if (!listing) return { changed: false };
  const projected = await loadProjection(executor, pkbProductId);
  const current = legacyStructuredFields(listing);
  if (sameStructuredFields(projected, current)) return { changed: false };

  const mirroredDetailKeys = new Set([
    ...Object.keys(LEGACY_DETAIL_DEFINITIONS),
    ...Object.keys(LEGACY_DETAIL_IDENTIFIERS),
  ]);
  const details = { ...((listing.details as Record<string, unknown> | null) ?? {}) };
  for (const key of Object.keys(details)) if (mirroredDetailKeys.has(key)) delete details[key];
  Object.assign(details, projected.details);

  const mapped: { id: string }[] = await executor
    .select({ id: pkbLegacyAttributeMap.categoryAttributeId })
    .from(pkbLegacyAttributeMap);
  const mirroredAttributeKeys = new Set(mapped.map((row) => row.id));
  const attributeValues = { ...((listing.attributeValues as Record<string, unknown> | null) ?? {}) };
  for (const key of Object.keys(attributeValues)) if (mirroredAttributeKeys.has(key)) delete attributeValues[key];
  Object.assign(attributeValues, projected.attributeValues);

  const compliance = { ...((listing.compliance as Record<string, unknown> | null) ?? {}) };
  if (projected.countryOfOrigin) compliance.countryOfOrigin = projected.countryOfOrigin;
  else delete compliance.countryOfOrigin;

  await executor
    .update(products)
    .set({
      brand: projected.brand,
      identifierType: projected.identifierType,
      identifierValue: projected.identifierValue,
      details: Object.keys(details).length > 0 ? details : null,
      attributeValues: Object.keys(attributeValues).length > 0 ? attributeValues : null,
      boxContents: projected.boxContents.length > 0 ? projected.boxContents : null,
      compliance: Object.keys(compliance).length > 0 ? compliance : null,
      updatedAt: new Date(),
    })
    .where(eq(products.id, listingId));
  return { changed: true };
}
