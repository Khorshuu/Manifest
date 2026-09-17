/**
 * Trade identifiers, normalized by type (DECISIONS.md D-065).
 *
 * A GTIN in any of its lengths names one trade item, so UPC-A "012345678905",
 * EAN-13 "0012345678905" and GTIN-14 "00012345678905" are the same number; the
 * knowledge base stores the 14-digit form for uniqueness and keeps what was
 * written. A number whose check digit is wrong is kept, marked invalid, and
 * never treated as an identifier of anything.
 */

export const IDENTIFIER_TYPES = [
  "gtin8",
  "gtin12",
  "gtin13",
  "gtin14",
  "isbn10",
  "isbn13",
  "mpn",
  "model_number",
  "asin",
  "other",
] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/**
 * What a caller may name: the stored types, plus the families a person types
 * without knowing the length ("a GTIN", "the UPC", "an ISBN").
 */
export type IdentifierInputType = IdentifierType | "gtin" | "upc" | "ean" | "isbn";

export type IdentifierValidation = "valid" | "invalid" | "unchecked";

export type NormalizedIdentifier = {
  type: IdentifierType;
  raw: string;
  /** Null when invalid. */
  normalized: string | null;
  /** The GTIN-14 form, for GTIN-family identifiers that are valid. */
  gtin14: string | null;
  validation: IdentifierValidation;
  reason: string | null;
};

const GTIN_TYPES = new Set<IdentifierType>(["gtin8", "gtin12", "gtin13", "gtin14", "isbn10", "isbn13"]);

export function isGtinFamily(type: IdentifierType): boolean {
  return GTIN_TYPES.has(type);
}

/** The GS1 mod-10 check: weights 3 and 1 from the right, excluding the check digit. */
export function gtinCheckDigitValid(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index++) {
    const digit = Number(body[body.length - 1 - index]);
    sum += digit * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

function isbn10Valid(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 10; index++) {
    const character = value[index];
    const digit = character === "X" ? 10 : Number(character);
    sum += digit * (10 - index);
  }
  return sum % 11 === 0;
}

function isbn10To13(isbn10: string): string {
  const body = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let index = 0; index < 12; index++) {
    sum += Number(body[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/**
 * The matching key for a manufacturer part or model number: case and
 * punctuation folded, so "WH-1000XM6", "wh 1000xm6" and "WH1000XM6" are one.
 */
export function modelKey(raw: string): string {
  return raw.normalize("NFKC").toUpperCase().replace(/[\s\-_.\/\\]+/g, "");
}

function result(
  type: IdentifierType,
  raw: string,
  normalized: string | null,
  validation: IdentifierValidation,
  reason: string | null = null,
): NormalizedIdentifier {
  let gtin14: string | null = null;
  if (validation === "valid" && isGtinFamily(type) && normalized) {
    gtin14 = (type === "isbn10" ? isbn10To13(normalized) : normalized).padStart(14, "0");
  }
  return { type, raw, normalized: validation === "invalid" ? null : normalized, gtin14, validation, reason };
}

export function normalizeIdentifier(
  inputType: IdentifierInputType,
  rawValue: string,
): NormalizedIdentifier {
  const raw = rawValue.normalize("NFKC").trim().replace(/\s+/g, " ");
  const compact = raw.replace(/[\s-]/g, "");

  switch (inputType) {
    case "gtin":
    case "gtin8":
    case "gtin12":
    case "gtin13":
    case "gtin14":
    case "upc":
    case "ean": {
      const lengthType: Record<number, IdentifierType> = { 8: "gtin8", 12: "gtin12", 13: "gtin13", 14: "gtin14" };
      const type = /^\d+$/.test(compact) ? lengthType[compact.length] : undefined;
      const allowed: Record<string, IdentifierType[]> = {
        gtin: ["gtin8", "gtin12", "gtin13", "gtin14"],
        upc: ["gtin12"],
        ean: ["gtin13", "gtin8"],
        gtin8: ["gtin8"],
        gtin12: ["gtin12"],
        gtin13: ["gtin13"],
        gtin14: ["gtin14"],
      };
      const fallback: IdentifierType =
        inputType === "upc" ? "gtin12" : inputType === "ean" ? "gtin13" : inputType === "gtin" ? "gtin13" : inputType;
      if (!type || !allowed[inputType].includes(type)) {
        return result(fallback, raw, null, "invalid", "wrong length or not digits");
      }
      if (!gtinCheckDigitValid(compact)) {
        return result(type, raw, null, "invalid", "check digit does not match");
      }
      return result(type, raw, compact, "valid");
    }
    case "isbn":
    case "isbn10":
    case "isbn13": {
      const value = compact.toUpperCase();
      if (/^97[89]\d{10}$/.test(value) && inputType !== "isbn10") {
        return gtinCheckDigitValid(value)
          ? result("isbn13", raw, value, "valid")
          : result("isbn13", raw, null, "invalid", "check digit does not match");
      }
      if (/^\d{9}[\dX]$/.test(value) && inputType !== "isbn13") {
        return isbn10Valid(value)
          ? result("isbn10", raw, value, "valid")
          : result("isbn10", raw, null, "invalid", "check digit does not match");
      }
      return result(inputType === "isbn10" ? "isbn10" : "isbn13", raw, null, "invalid", "not an ISBN");
    }
    case "asin": {
      const value = compact.toUpperCase();
      return /^[A-Z0-9]{10}$/.test(value)
        ? result("asin", raw, value, "valid")
        : result("asin", raw, null, "invalid", "an ASIN is ten letters and digits");
    }
    case "mpn":
    case "model_number": {
      const key = modelKey(raw);
      return key
        ? result(inputType, raw, key, "unchecked")
        : result(inputType, raw, null, "invalid", "empty");
    }
    case "other": {
      return raw ? result("other", raw, raw, "unchecked") : result("other", raw, null, "invalid", "empty");
    }
  }
}

/** The legacy `products.identifier_type` vocabulary, mapped to what is typed. */
export const LEGACY_IDENTIFIER_TYPES: Record<string, IdentifierInputType> = {
  gtin: "gtin",
  upc: "upc",
  ean: "ean",
  isbn: "isbn",
  asin: "asin",
  mpn: "mpn",
  other: "other",
};
