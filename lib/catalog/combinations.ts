/**
 * Combination generation for the variation engine.
 *
 * Pure functions, deliberately free of database concerns: generating the
 * matrix is the part most likely to be wrong, and it is far easier to be sure
 * of it when it can be tested directly.
 */

export type AttributeAxis = {
  attributeId: string;
  name: string;
  values: { id: string; value: string }[];
};

export type Combination = {
  /** One chosen value per axis, in the order the axes were given. */
  options: { attributeId: string; attributeValueId: string; value: string }[];
  /** Human-readable summary, e.g. "Red / 128GB". */
  label: string;
  /** Stable key for matching against variants that already exist. */
  key: string;
};

/**
 * A guard rather than a limit anyone should hit: five axes of five values is
 * 3,125 variants, which is already unmanageable in a UI. Generating tens of
 * thousands of rows by accident would be a much worse outcome than an error.
 */
export const MAX_COMBINATIONS = 500;

export class TooManyCombinationsError extends Error {
  readonly status = 400;

  constructor(count: number) {
    super(
      `That would create ${count} variants, more than the ${MAX_COMBINATIONS} allowed. Use fewer attributes or values.`,
    );
    this.name = "TooManyCombinationsError";
  }
}

/** Sorted so the key does not depend on the order axes happen to arrive in. */
export function combinationKey(
  options: { attributeId: string; attributeValueId: string }[],
): string {
  return [...options]
    .sort((a, b) => a.attributeId.localeCompare(b.attributeId))
    .map((option) => `${option.attributeId}:${option.attributeValueId}`)
    .join("|");
}

export function countCombinations(axes: AttributeAxis[]): number {
  if (axes.length === 0) return 0;
  return axes.reduce((total, axis) => total * axis.values.length, 1);
}

/**
 * Cartesian product across the axes. An axis with no values makes the whole
 * product empty, which is correct: there is no combination to make.
 */
export function generateCombinations(axes: AttributeAxis[]): Combination[] {
  if (axes.length === 0) return [];
  if (axes.some((axis) => axis.values.length === 0)) return [];

  const total = countCombinations(axes);
  if (total > MAX_COMBINATIONS) throw new TooManyCombinationsError(total);

  let rows: Combination["options"][] = [[]];

  for (const axis of axes) {
    const next: Combination["options"][] = [];
    for (const row of rows) {
      for (const value of axis.values) {
        next.push([
          ...row,
          {
            attributeId: axis.attributeId,
            attributeValueId: value.id,
            value: value.value,
          },
        ]);
      }
    }
    rows = next;
  }

  return rows.map((options) => ({
    options,
    label: options.map((option) => option.value).join(" / "),
    key: combinationKey(options),
  }));
}

/**
 * Splits generated combinations against the ones a product already has, so a
 * regeneration adds what is missing without disturbing variants that already
 * carry prices, capacity, or orders.
 */
export function diffCombinations(
  generated: Combination[],
  existingKeys: string[],
): { toCreate: Combination[]; unchanged: Combination[]; orphanedKeys: string[] } {
  const existing = new Set(existingKeys);
  const generatedKeys = new Set(generated.map((combination) => combination.key));

  return {
    toCreate: generated.filter((c) => !existing.has(c.key)),
    unchanged: generated.filter((c) => existing.has(c.key)),
    orphanedKeys: existingKeys.filter((key) => !generatedKeys.has(key)),
  };
}

/**
 * Builds an SKU from a product code and the chosen values. Uppercased and
 * punctuation-free so it stays scannable and safe in a URL or a CSV.
 */
export function buildSku(productCode: string, combination: Combination): string {
  const parts = combination.options.map((option) =>
    option.value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, 6),
  );

  return [productCode.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12), ...parts]
    .filter(Boolean)
    .join("-");
}
