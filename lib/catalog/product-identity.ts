import { ValidationError } from "@/lib/errors";
import { normalizeIdentifier } from "@/lib/pkb/identifiers";
import { TRADE_IDENTIFIER_FIELDS, type ProductIdentityPayload } from "@/lib/validation/catalog";

/**
 * Where manufacturer identity is stored (D-112).
 *
 * Nothing new is stored. The identity a product save may now carry is folded
 * into the two places the knowledge mirror already reads:
 *
 *  - `products.details.modelName`, `.modelNumber` and
 *    `.manufacturerPartNumber`, which `lib/pkb/sync.ts` maps to the
 *    `model_name` attribute and to `model_number` / `mpn` identifiers;
 *  - `products.identifier_type` and `products.identifier_value`, the one trade
 *    identifier a listing carries, which the mirror normalises and check-digit
 *    validates (D-065).
 *
 * That is the whole point of doing it this way: identity entered on the Add
 * Product form and identity entered on the Product Intelligence screen end up
 * as the same rows, with the same provenance, under the same rules. A second
 * identifier store would have had to be reconciled with the first for ever.
 *
 * The one real limitation is honest and deliberate: a listing holds one trade
 * identifier, because the column does. A product with both a UPC and an EAN is
 * a product with one GTIN written two ways, and the normaliser folds them to
 * the same GTIN-14 anyway. Supplying two different kinds at once is refused
 * rather than silently resolved.
 */

export type IdentityColumns = {
  details?: Record<string, string | null>;
  identifierType?: string | null;
  identifierValue?: string | null;
};

const DETAIL_OF: Record<"modelName" | "modelNumber" | "mpn", string> = {
  modelName: "modelName",
  modelNumber: "modelNumber",
  mpn: "manufacturerPartNumber",
};

/**
 * Folds an identity block into the columns a save writes.
 *
 * `existingDetails` is whatever the save will already write to `details` — the
 * stored object on an update that does not send the details panel, or the
 * panel's own value when it does — so identity adds to it rather than
 * replacing it. A field set to null clears that one value and leaves the rest.
 */
export function identityColumns(
  identity: ProductIdentityPayload | undefined,
  existingDetails: Record<string, unknown> | null | undefined,
  explicit: { identifierType?: string | null; identifierValue?: string | null },
): IdentityColumns {
  if (!identity) return {};
  const columns: IdentityColumns = {};

  const details: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(existingDetails ?? {})) {
    if (typeof value === "string" && value.trim()) details[key] = value;
  }
  let touchedDetails = false;
  for (const field of ["modelName", "modelNumber", "mpn"] as const) {
    const value = identity[field];
    if (value === undefined) continue;
    touchedDetails = true;
    if (value === null) delete details[DETAIL_OF[field]];
    else details[DETAIL_OF[field]] = value;
  }
  if (touchedDetails) columns.details = details;

  const supplied = TRADE_IDENTIFIER_FIELDS.filter((field) => identity[field] !== undefined);
  if (supplied.length === 0) return columns;

  const withValue = supplied.filter((field) => identity[field] !== null);
  if (withValue.length > 1) {
    throw new ValidationError(
      `Record one trade identifier, not ${withValue.length}. A product carries one number; ${withValue.join(", ")} are different ways of writing it or different numbers entirely.`,
      "identifier_ambiguous",
    );
  }

  // Every supplied field was null: the identifier is being cleared.
  if (withValue.length === 0) {
    if (explicit.identifierValue) return columns;
    columns.identifierType = null;
    columns.identifierValue = null;
    return columns;
  }

  const field = withValue[0];
  const value = identity[field] as string;

  // A save that also names the identifier directly has to agree with itself.
  if (explicit.identifierValue != null && explicit.identifierValue.trim() !== value.trim()) {
    throw new ValidationError(
      "The trade identifier was sent twice with two different values. Send it once.",
      "identifier_conflict",
    );
  }
  if (explicit.identifierType != null && explicit.identifierType !== field) {
    throw new ValidationError(
      `The identifier is described as a ${explicit.identifierType} and as a ${field}. Send it once.`,
      "identifier_conflict",
    );
  }

  /*
   * Refused here rather than stored and marked invalid later. A mistyped GTIN
   * is the one identity mistake that quietly points an enrichment run at
   * another product entirely, and the check digit catches most of them at the
   * moment somebody can still look at the box.
   */
  const normalized = normalizeIdentifier(field, value);
  if (normalized.validation === "invalid") {
    throw new ValidationError(
      `That ${field.toUpperCase()} is not valid: ${normalized.reason ?? "it could not be read"}.`,
      "identifier_invalid",
    );
  }

  columns.identifierType = field;
  columns.identifierValue = value;
  return columns;
}
