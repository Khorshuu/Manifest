import { sql } from "drizzle-orm";
import { db } from "@/db";
import { queryRows, type Executor } from "./common";
import { resolveFamilySchema } from "./families";

/**
 * What the knowledge base is willing to publish about a product (D-080).
 *
 * Structured data is a claim made to the world, so it carries only what the
 * knowledge base has actually established: a value whose state is VERIFIED or
 * MANUAL (invariant I-11). A legacy value of unknown origin, a suggested one
 * and one still in conflict are all left out — an identifier nobody checked is
 * worse in a rich result than no identifier at all.
 *
 * Nothing here decides how a value is presented; that is `lib/seo`. Nothing
 * here writes.
 */

/** States a value must be in before it is told to a search engine. */
const PUBLISHABLE = ["VERIFIED", "MANUAL"] as const;

export type PublishableIdentifier = {
  type: string;
  value: string;
  /** Null for a product-level identifier. */
  pkbVariantId: string | null;
  state: string;
};

export type PublishableProperty = {
  /** The schema.org property this attribute maps to, e.g. "color", "material". */
  property: string;
  label: string;
  value: string;
  unit: string | null;
  pkbVariantId: string | null;
};

export type PublishableKnowledge = {
  pkbProductId: string;
  /** The brand as the knowledge base holds it, when established. */
  brand: string | null;
  identifiers: PublishableIdentifier[];
  properties: PublishableProperty[];
};

export const EMPTY_PUBLISHABLE: PublishableKnowledge = {
  pkbProductId: "",
  brand: null,
  identifiers: [],
  properties: [],
};

/**
 * Reads the publishable knowledge of one product and its variants. One pass;
 * safe to call from a cached storefront read.
 */
export async function publishableKnowledge(
  pkbProductId: string | null,
  executor: Executor = db,
): Promise<PublishableKnowledge> {
  if (!pkbProductId) return EMPTY_PUBLISHABLE;
  const states = `{${PUBLISHABLE.join(",")}}`;

  const [brandRows, identifierRows, propertyRows] = await Promise.all([
    queryRows<{ name: string }>(
      executor,
      sql`select b.name
          from pkb_facts f
          join pkb_attribute_definitions d on d.id = f.definition_id
          join pkb_brands b on b.id = f.value_brand_id
          where f.pkb_product_id = ${pkbProductId}
            and f.pkb_variant_id is null
            and d.key = 'brand'
            and f.value_status <> 'not_applicable'
            and f.verification_state = any(${states}::text[])
            and b.status = 'active'
          limit 1`,
    ),
    queryRows<{ identifier_type: string; value: string; pkb_variant_id: string | null; verification_state: string }>(
      executor,
      sql`select identifier_type, coalesce(value_normalized, value_raw) as value,
                 pkb_variant_id, verification_state
          from pkb_identifiers
          where pkb_product_id = ${pkbProductId}
            and validation_status = 'valid'
            and verification_state = any(${states}::text[])
          order by identifier_type`,
    ),
    queryRows<{
      property: string;
      label: string;
      value: string;
      unit: string | null;
      pkb_variant_id: string | null;
    }>(
      executor,
      sql`select d.structured_data_property as property, d.label,
                 coalesce(f.value_text, o.label, f.raw_value) as value,
                 coalesce(f.value_unit, f.raw_unit) as unit,
                 f.pkb_variant_id
          from pkb_facts f
          join pkb_attribute_definitions d on d.id = f.definition_id
          left join pkb_attribute_options o on o.id = f.value_option_id
          where f.pkb_product_id = ${pkbProductId}
            and d.structured_data_property is not null
            and f.value_status <> 'not_applicable'
            and f.verification_state = any(${states}::text[])
            and coalesce(f.value_text, o.label, f.raw_value) is not null
          order by d.label, f.ordinal`,
    ),
  ]);

  return {
    pkbProductId,
    brand: brandRows[0]?.name ?? null,
    identifiers: identifierRows.map((row) => ({
      type: row.identifier_type,
      value: row.value,
      pkbVariantId: row.pkb_variant_id,
      state: row.verification_state,
    })),
    properties: propertyRows.map((row) => ({
      property: row.property,
      label: row.label,
      value: row.value,
      unit: row.unit,
      pkbVariantId: row.pkb_variant_id,
    })),
  };
}

/** The best identifier of each kind for one subject (the product, or one variant). */
export function identifiersFor(
  knowledge: PublishableKnowledge,
  pkbVariantId: string | null,
): { gtin: string | null; mpn: string | null; sku: null } {
  const scoped = knowledge.identifiers.filter((row) =>
    pkbVariantId === null ? row.pkbVariantId === null : row.pkbVariantId === pkbVariantId || row.pkbVariantId === null,
  );
  const gtin =
    scoped.find((row) => row.type === "gtin13")?.value ??
    scoped.find((row) => row.type === "gtin12")?.value ??
    scoped.find((row) => row.type === "gtin14")?.value ??
    scoped.find((row) => row.type === "gtin8")?.value ??
    scoped.find((row) => row.type === "isbn13")?.value ??
    null;
  const mpn = scoped.find((row) => row.type === "mpn")?.value ?? scoped.find((row) => row.type === "model_number")?.value ?? null;
  // The merchant SKU is the offer's own, not knowledge; the caller supplies it.
  return { gtin, mpn, sku: null };
}

// ------------------------------------------------- grounded generation context

/**
 * The same publishable knowledge, widened for a generator (D-113).
 *
 * `publishableKnowledge` above answers a narrower question — what may be told
 * to a search engine as structured data — so it carries only the attributes
 * that map to a schema.org property. A generator writing customer-facing copy
 * needs more than that: the materials, the measurements, the box contents, the
 * compatibility notes. It needs them under exactly the same rule, though, so
 * this reads through the same filter: a value is included only when its state
 * is VERIFIED or MANUAL (invariant I-11), and nothing suggested, conflicting
 * or of unknown legacy origin appears at all.
 *
 * Read-only, and factual only. Prices, stock, preorder capacity and promotions
 * are offer data and are not in the knowledge base to begin with (I-8). What a
 * generator writes from this never comes back: generated prose is not evidence
 * and cannot become a fact (I-1, D-074).
 */
export type GroundedAttribute = {
  /** The attribute's canonical key, e.g. "material", "item_weight". */
  key: string;
  label: string;
  value: string;
  unit: string | null;
  /** Null for a product-level value; set for one variant's. */
  pkbVariantId: string | null;
  state: string;
};

export type GroundedRelationship = {
  kind: string;
  /** The other product's name in the knowledge base. */
  name: string;
  direction: "outgoing" | "incoming";
};

/**
 * What this kind of product is expected to be described by (D-123): the
 * product's family and its effective schema. Schema, not knowledge — it says
 * which attributes matter, never what their values are.
 */
export type GroundedFamily = {
  id: string;
  name: string;
  attributes: { key: string; label: string; requirement: "required" | "recommended" | "optional" }[];
};

export type GroundedKnowledge = {
  pkbProductId: string | null;
  /** The knowledge base's own name for the product, which may differ from the listing's title. */
  name: string | null;
  brand: string | null;
  modelName: string | null;
  resolutionState: string | null;
  identifiers: PublishableIdentifier[];
  attributes: GroundedAttribute[];
  relationships: GroundedRelationship[];
  /** Null when the product has no family yet; absent in older callers' fixtures. */
  family?: GroundedFamily | null;
};

export const EMPTY_GROUNDED: GroundedKnowledge = {
  pkbProductId: null,
  name: null,
  brand: null,
  modelName: null,
  resolutionState: null,
  identifiers: [],
  attributes: [],
  relationships: [],
};

export async function groundedKnowledge(
  pkbProductId: string | null,
  executor: Executor = db,
): Promise<GroundedKnowledge> {
  if (!pkbProductId) return EMPTY_GROUNDED;
  const states = `{${PUBLISHABLE.join(",")}}`;

  const [productRows, identifierRows, attributeRows, relationshipRows] = await Promise.all([
    queryRows<{ name: string; resolution_state: string; family_id: string | null; family_name: string | null }>(
      executor,
      sql`select p.name, p.resolution_state, f.id as family_id, f.name as family_name
          from pkb_products p
          left join pkb_families f on f.id = p.family_id and f.status = 'approved'
          where p.id = ${pkbProductId} and p.status = 'active'`,
    ),
    queryRows<{ identifier_type: string; value: string; pkb_variant_id: string | null; verification_state: string }>(
      executor,
      sql`select identifier_type, coalesce(value_normalized, value_raw) as value,
                 pkb_variant_id, verification_state
          from pkb_identifiers
          where pkb_product_id = ${pkbProductId}
            and validation_status <> 'invalid'
            and verification_state = any(${states}::text[])
          order by identifier_type`,
    ),
    queryRows<{
      key: string;
      label: string;
      value: string;
      unit: string | null;
      pkb_variant_id: string | null;
      verification_state: string;
    }>(
      executor,
      sql`select d.key, d.label,
                 coalesce(b.name, o.label, f.value_text, f.raw_value) as value,
                 coalesce(f.value_unit, f.raw_unit) as unit,
                 f.pkb_variant_id, f.verification_state
          from pkb_facts f
          join pkb_attribute_definitions d on d.id = f.definition_id
          left join pkb_attribute_options o on o.id = f.value_option_id
          left join pkb_brands b on b.id = f.value_brand_id
          where f.pkb_product_id = ${pkbProductId}
            and f.value_status <> 'not_applicable'
            and f.verification_state = any(${states}::text[])
            and coalesce(b.name, o.label, f.value_text, f.raw_value) is not null
          order by d.label, f.ordinal`,
    ),
    // Only relationships the knowledge base has settled, in either direction.
    queryRows<{ kind: string; name: string; direction: string }>(
      executor,
      sql`select r.kind, p.name, 'outgoing' as direction
          from pkb_relationships r
          join pkb_products p on p.id = r.to_product_id
          where r.from_product_id = ${pkbProductId}
            and r.verification_state = any(${states}::text[]) and p.status = 'active'
          union all
          select r.kind, p.name, 'incoming' as direction
          from pkb_relationships r
          join pkb_products p on p.id = r.from_product_id
          where r.to_product_id = ${pkbProductId}
            and r.verification_state = any(${states}::text[]) and p.status = 'active'
          order by 1, 2
          limit 50`,
    ),
  ]);

  const attributes = attributeRows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.value,
    unit: row.unit,
    pkbVariantId: row.pkb_variant_id,
    state: row.verification_state,
  }));

  const familyId = productRows[0]?.family_id ?? null;
  const schema = familyId ? await resolveFamilySchema(executor, familyId) : [];
  const family: GroundedFamily | null = familyId
    ? {
        id: familyId,
        name: productRows[0].family_name ?? "",
        attributes: schema
          .filter((attribute) => attribute.definition.status === "approved")
          .map((attribute) => ({
            key: attribute.definition.key,
            label: attribute.definition.label,
            requirement: attribute.requirement,
          })),
      }
    : null;

  return {
    pkbProductId,
    family,
    name: productRows[0]?.name ?? null,
    brand: attributes.find((row) => row.key === "brand")?.value ?? null,
    modelName: attributes.find((row) => row.key === "model_name")?.value ?? null,
    resolutionState: productRows[0]?.resolution_state ?? null,
    identifiers: identifierRows.map((row) => ({
      type: row.identifier_type,
      value: row.value,
      pkbVariantId: row.pkb_variant_id,
      state: row.verification_state,
    })),
    attributes,
    relationships: relationshipRows.map((row) => ({
      kind: row.kind,
      name: row.name,
      direction: row.direction === "incoming" ? "incoming" : "outgoing",
    })),
  };
}
