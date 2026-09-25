import {
  isQuantityFailure,
  isUnitDimension,
  parseNumberText,
  parseQuantity,
  parseQuantityRange,
} from "./units";

/**
 * Turning a written value into the typed value an attribute definition asks
 * for (DECISIONS.md D-065). Pure: no database. The raw text always survives
 * beside whatever this returns, and anything that cannot be read with
 * certainty comes back `unnormalized` with the reason — never a guess.
 */

export const ATTRIBUTE_DATA_TYPES = [
  "text",
  "number",
  "quantity",
  "quantity_range",
  "boolean",
  "enum",
  "date",
  "url",
  "brand",
] as const;
export type AttributeDataType = (typeof ATTRIBUTE_DATA_TYPES)[number];

export type DefinitionShape = {
  dataType: AttributeDataType;
  unitDimension: string | null;
  options?: { id: string; key: string; label: string; aliases?: string[] }[];
};

export type TypedValue = {
  text: string | null;
  number: string | null;
  numberMax: string | null;
  unit: string | null;
  boolean: boolean | null;
  date: string | null;
  optionId: string | null;
  /** For brand definitions: the brand as written, resolved to an entity by the caller. */
  brandName: string | null;
};

export type NormalizationResult =
  | { status: "normalized"; value: TypedValue }
  | { status: "unnormalized"; reason: string };

export const EMPTY_TYPED: TypedValue = {
  text: null,
  number: null,
  numberMax: null,
  unit: null,
  boolean: null,
  date: null,
  optionId: null,
  brandName: null,
};

/** The longest text value the knowledge base keeps. */
export const MAX_TEXT_LENGTH = 4000;

/**
 * Characters that carry nothing a reader sees and that a database either
 * cannot store or stores as noise.
 *
 * Deliberately a short, named list rather than the whole of Unicode's "Cf"
 * (format) category. Most of Cf is meaningful: the zero-width joiner holds
 * an emoji sequence together, the zero-width non-joiner changes how Persian
 * and several Indic scripts are shaped, the bidirectional marks decide the
 * order right-to-left text is read in, and the Arabic number signs are part
 * of the number. None of those is touched. What is removed is what a
 * manufacturer's page leaves behind from its editor:
 *
 *  - NUL and the other C0 controls except tab, line feed and carriage
 *    return (PostgreSQL refuses NUL in `text` and `jsonb` outright);
 *  - U+200B zero-width space, U+2060 word joiner and U+FEFF, the byte-order
 *    mark that also appears mid-text as a zero-width no-break space;
 *  - U+00AD soft hyphen, which only ever says where a word may be broken;
 *  - U+2061–U+2064, the invisible mathematical operators;
 *  - U+206A–U+206F, format controls Unicode itself deprecates;
 *  - U+FFF9–U+FFFB, interlinear annotation anchors.
 *
 * Nothing is transliterated, accents and symbols are untouched, and a value
 * that was already clean comes back as the same string.
 */
const STORAGE_NOISE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­​⁠-⁤⁪-⁯﻿￹-￻]/g;

export function removeStorageNoise(value: string): string {
  return value.replace(STORAGE_NOISE, "");
}

/**
 * `removeStorageNoise` applied to every string inside a parsed JSON value,
 * keys included. JSON-LD can spell the same characters as escapes
 * (`"​"`, `"\u0000"`) that only exist once the text has been parsed, so
 * cleaning the page before parsing is not enough for what is stored as
 * `jsonb`.
 */
export function removeStorageNoiseDeep<T>(value: T, depth = 0): T {
  if (depth > 32) return value;
  if (typeof value === "string") return removeStorageNoise(value) as T;
  if (Array.isArray(value)) return value.map((entry) => removeStorageNoiseDeep(entry, depth + 1)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        removeStorageNoise(key),
        removeStorageNoiseDeep(entry, depth + 1),
      ]),
    ) as T;
  }
  return value;
}

/** Whitespace collapsed and Unicode composed; the form every raw value is stored in. */
export function cleanText(value: string): string {
  return removeStorageNoise(value.normalize("NFC")).replace(/\s+/g, " ").trim();
}

/**
 * The comparison key of a label or a name: case, accents and punctuation
 * folded. "Colour:", "colour" and "COLOUR" are one key.
 */
export function labelKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The key a brand is matched on. Deliberately conservative: case, accents,
 * spacing and punctuation fold together, but nothing else does — "Delta Pepper
 * Co." and "Delta Pepper" stay two brands until a person says otherwise.
 */
export function brandKey(value: string): string {
  return labelKey(value);
}

/** A stable snake_case key from a label: "Refresh rate" → "refresh_rate". */
export function keyFromLabel(label: string, maxLength = 63): string {
  const base = labelKey(label).replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const key = /^[a-z]/.test(base) ? base : `k_${base}`;
  return key.slice(0, maxLength).replace(/_+$/, "") || "attribute";
}

/** A URL slug from a name: "Delta Pepper Co." → "delta-pepper-co". */
export function slugFromName(name: string): string {
  return labelKey(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "brand";
}

const BOOLEAN_TRUE = new Set(["true", "yes", "y", "1"]);
const BOOLEAN_FALSE = new Set(["false", "no", "n", "0"]);

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * ISO dates only, at the precision written: "2024", "2024-03", "2024-03-15".
 * "03/04/2024" is refused, because the day and month cannot be told apart.
 */
export function parseIsoDate(value: string): { text: string; date: string } | null {
  const text = value.trim().replace(/T.*$/, "");
  let match = /^(\d{4})$/.exec(text);
  if (match) return { text, date: `${match[1]}-01-01` };
  match = /^(\d{4})-(\d{2})$/.exec(text);
  if (match) {
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? { text, date: `${text}-01` } : null;
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match && isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return { text, date: text };
  }
  return null;
}

export function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function typed(partial: Partial<TypedValue>): NormalizationResult {
  return { status: "normalized", value: { ...EMPTY_TYPED, ...partial } };
}

function unnormalized(reason: string): NormalizationResult {
  return { status: "unnormalized", reason };
}

/**
 * Normalizes one written value for a definition. `defaultUnit` is used only
 * when the text carries no unit of its own.
 */
export function normalizeValue(
  definition: DefinitionShape,
  rawValue: string,
  context: { defaultUnit?: string | null } = {},
): NormalizationResult {
  const raw = cleanText(rawValue);
  if (!raw) return unnormalized("empty");
  if (raw.length > MAX_TEXT_LENGTH) return unnormalized("longer than the knowledge base keeps");

  switch (definition.dataType) {
    case "text":
      return typed({ text: raw });

    case "brand":
      return typed({ brandName: raw });

    case "url": {
      const url = normalizeUrl(raw);
      return url ? typed({ text: url }) : unnormalized("not an http(s) link");
    }

    case "boolean": {
      const key = raw.toLowerCase();
      if (BOOLEAN_TRUE.has(key)) return typed({ boolean: true });
      if (BOOLEAN_FALSE.has(key)) return typed({ boolean: false });
      return unnormalized("not a yes or no");
    }

    case "number": {
      const number = parseNumberText(raw);
      return number === null ? unnormalized("not a plain number") : typed({ number });
    }

    case "date": {
      const parsed = parseIsoDate(raw);
      return parsed ? typed({ date: parsed.date, text: parsed.text }) : unnormalized("not an ISO date");
    }

    case "enum": {
      const key = labelKey(raw);
      const option = (definition.options ?? []).find(
        (candidate) =>
          candidate.key === raw ||
          labelKey(candidate.label) === key ||
          labelKey(candidate.key.replace(/_/g, " ")) === key ||
          (candidate.aliases ?? []).some((alias) => labelKey(alias) === key),
      );
      return option ? typed({ optionId: option.id }) : unnormalized("not one of the defined options");
    }

    case "quantity": {
      if (!definition.unitDimension || !isUnitDimension(definition.unitDimension)) {
        return unnormalized("the definition has no unit dimension");
      }
      const parsed = parseQuantity(raw, definition.unitDimension, {
        defaultUnit: context.defaultUnit ?? undefined,
      });
      return isQuantityFailure(parsed)
        ? unnormalized(parsed.reason)
        : typed({ number: parsed.value, unit: parsed.unit });
    }

    case "quantity_range": {
      if (!definition.unitDimension || !isUnitDimension(definition.unitDimension)) {
        return unnormalized("the definition has no unit dimension");
      }
      const parsed = parseQuantityRange(raw, definition.unitDimension, {
        defaultUnit: context.defaultUnit ?? undefined,
      });
      return isQuantityFailure(parsed)
        ? unnormalized(parsed.reason)
        : typed({ number: parsed.min.value, numberMax: parsed.max.value, unit: parsed.min.unit });
    }
  }
}

/** Whether two typed values say the same thing. Numbers compare as canonical decimals. */
export function sameTypedValue(a: TypedValue, b: TypedValue): boolean {
  return (
    (a.text ?? null) === (b.text ?? null) &&
    (a.number ?? null) === (b.number ?? null) &&
    (a.numberMax ?? null) === (b.numberMax ?? null) &&
    (a.unit ?? null) === (b.unit ?? null) &&
    (a.boolean ?? null) === (b.boolean ?? null) &&
    (a.date ?? null) === (b.date ?? null) &&
    (a.optionId ?? null) === (b.optionId ?? null) &&
    (a.brandName === null) === (b.brandName === null) &&
    (a.brandName === null || b.brandName === null || brandKey(a.brandName) === brandKey(b.brandName))
  );
}

/**
 * The items of a list written as one value: "• 1× USB Receiver • 1× Cable"
 * is two things in the box, not one (D-119). Split only on bullet glyphs and
 * line breaks — a comma or a middle dot is as likely to sit inside an item
 * ("USB-A to USB-C, braided") as between two. A value that is not a list
 * comes back as itself.
 */
export function listItems(value: string): string[] {
  const items = value
    .split(/[\r\n]+|[•▪◦●‣⁃]/)
    .map((item) => cleanText(item))
    .filter((item) => item.length > 0);
  return items.length > 1 ? items : [cleanText(value).replace(/^[•▪◦●‣⁃]\s*/, "")];
}
