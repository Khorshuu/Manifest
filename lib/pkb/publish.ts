import { sql } from "drizzle-orm";
import { db } from "@/db";
import { queryRows, type Executor } from "./common";

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
