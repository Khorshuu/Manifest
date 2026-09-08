/**
 * Splitting a landed price into what it is made of.
 *
 * The promise to shoppers is one fixed price with shipping and customs duty
 * already inside it (MASTER_PRODUCT_SPEC.md section 5). So this never adds
 * anything: the price is the input, and the split is derived from it. Nobody
 * is charged a taka more because the breakdown exists.
 *
 * Working the other way — goods plus freight plus duty at checkout — is what
 * every other importer does, and it is exactly the surprise this shop exists
 * to avoid.
 */

export type LandedRates = {
  /** Freight per kilogram, in paisa. */
  shippingPerKgBdt: number;
  /** Duty as a percentage of the goods value. */
  dutyPercent: number;
  /** Used when a variant has no weight recorded. */
  assumedWeightGrams: number;
};

export type LandedBreakdown = {
  /** What the goods themselves are worth, in paisa. */
  goodsBdt: number;
  shippingBdt: number;
  dutyBdt: number;
  /** Always equals the landed price that went in. */
  totalBdt: number;
};

export type LandedLine = {
  /** The price a shopper sees, per unit, in paisa. */
  unitPriceBdt: number;
  quantity: number;
  weightGrams: number | null;
};

/**
 * Splits one line. Rounding is absorbed by duty rather than spread, so the
 * three parts always add back to exactly the landed price — a breakdown that
 * does not sum to the total is worse than no breakdown.
 */
export function splitLandedLine(
  line: LandedLine,
  rates: LandedRates,
): LandedBreakdown {
  const total = Math.max(0, Math.round(line.unitPriceBdt * line.quantity));

  if (total === 0) {
    return { goodsBdt: 0, shippingBdt: 0, dutyBdt: 0, totalBdt: 0 };
  }

  const grams =
    (line.weightGrams ?? rates.assumedWeightGrams) * Math.max(1, line.quantity);

  // Freight first: it does not depend on what the goods are worth.
  const shipping = Math.min(
    total,
    Math.round((rates.shippingPerKgBdt * grams) / 1000),
  );

  // What is left covers the goods and the duty charged on them, so the goods
  // value is that amount divided by one plus the duty rate.
  const remainder = total - shipping;
  const goods = Math.round(remainder / (1 + rates.dutyPercent / 100));
  const duty = remainder - goods;

  return {
    goodsBdt: goods,
    shippingBdt: shipping,
    dutyBdt: duty,
    totalBdt: total,
  };
}

/** Splits a whole order, line by line. */
export function splitLandedOrder(
  lines: LandedLine[],
  rates: LandedRates,
): LandedBreakdown {
  return lines.reduce<LandedBreakdown>(
    (sum, line) => {
      const part = splitLandedLine(line, rates);
      return {
        goodsBdt: sum.goodsBdt + part.goodsBdt,
        shippingBdt: sum.shippingBdt + part.shippingBdt,
        dutyBdt: sum.dutyBdt + part.dutyBdt,
        totalBdt: sum.totalBdt + part.totalBdt,
      };
    },
    { goodsBdt: 0, shippingBdt: 0, dutyBdt: 0, totalBdt: 0 },
  );
}
