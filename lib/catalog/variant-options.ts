import { eq, inArray } from "drizzle-orm";
import { db, type Database } from "@/db";
import {
  attributeValues,
  attributes,
  variantOptionValues,
} from "@/db/schema";

/**
 * What a variant actually is, as named pairs (DECISIONS.md D-043).
 *
 * The cart, the checkout summary and the order snapshot all have to say
 * "Colour: Pearl White" rather than a bare product name, and they must agree
 * with each other — so the pairs are read in one place and formatted in one
 * place.
 */
export type VariantOption = { label: string; value: string };

type Handle = Pick<Database, "select">;

export async function loadVariantOptions(
  variantIds: string[],
  handle: Handle = db,
): Promise<Map<string, VariantOption[]>> {
  const byVariant = new Map<string, VariantOption[]>();
  if (variantIds.length === 0) return byVariant;

  const rows = await handle
    .select({
      variantId: variantOptionValues.variantId,
      label: attributes.name,
      value: attributeValues.value,
      position: attributeValues.sortOrder,
    })
    .from(variantOptionValues)
    .innerJoin(
      attributeValues,
      eq(variantOptionValues.attributeValueId, attributeValues.id),
    )
    .innerJoin(attributes, eq(variantOptionValues.attributeId, attributes.id))
    .where(inArray(variantOptionValues.variantId, variantIds));

  // Sorted by option name so two lines describing the same variant never read
  // in a different order — "Colour · Size" on one screen, "Size · Colour" on
  // the next.
  for (const row of [...rows].sort(
    (a, b) => a.label.localeCompare(b.label) || a.position - b.position,
  )) {
    const list = byVariant.get(row.variantId) ?? [];
    list.push({ label: row.label, value: row.value });
    byVariant.set(row.variantId, list);
  }

  return byVariant;
}

/**
 * "Pearl White · 3-Seater" — the values alone, for a line that already says
 * what product it belongs to. Empty when the product has no options at all,
 * which is not the same as a variant called "Standard": a single-variant
 * product should read as its own name and nothing more.
 */
export function summariseOptions(options: VariantOption[] | null): string {
  if (!options || options.length === 0) return "";
  return options.map((option) => option.value).join(" · ");
}
