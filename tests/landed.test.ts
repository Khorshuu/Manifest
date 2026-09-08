/**
 * Splitting a landed price.
 *
 * The invariant that matters: the parts always add back to exactly the price
 * the shopper agreed to. A breakdown that does not sum to the total would make
 * every order page argue with itself, and the promise this shop is built on is
 * that there is nothing more to pay.
 */
import { describe, expect, it } from "vitest";
import { splitLandedLine, splitLandedOrder, type LandedRates } from "@/lib/pricing";

const rates: LandedRates = {
  shippingPerKgBdt: 950_00,
  dutyPercent: 32,
  assumedWeightGrams: 500,
};

describe("splitting one line", () => {
  it("adds back to exactly the landed price", () => {
    const split = splitLandedLine(
      { unitPriceBdt: 1850_00, quantity: 1, weightGrams: 680 },
      rates,
    );

    expect(split.goodsBdt + split.shippingBdt + split.dutyBdt).toBe(
      split.totalBdt,
    );
    expect(split.totalBdt).toBe(1850_00);
  });

  it("charges freight by weight", () => {
    const light = splitLandedLine(
      { unitPriceBdt: 5000_00, quantity: 1, weightGrams: 100 },
      rates,
    );
    const heavy = splitLandedLine(
      { unitPriceBdt: 5000_00, quantity: 1, weightGrams: 2000 },
      rates,
    );

    expect(light.shippingBdt).toBe(95_00);
    expect(heavy.shippingBdt).toBe(1900_00);
    // Same price either way: this is a split, never a surcharge.
    expect(light.totalBdt).toBe(heavy.totalBdt);
  });

  it("applies duty to the goods value, not to the whole price", () => {
    const split = splitLandedLine(
      { unitPriceBdt: 1000_00, quantity: 1, weightGrams: 0 },
      { ...rates, shippingPerKgBdt: 0, dutyPercent: 25 },
    );

    // 800 of goods plus 25% duty is 1000.
    expect(split.goodsBdt).toBe(800_00);
    expect(split.dutyBdt).toBe(200_00);
  });

  it("uses the assumed weight when a variant has none", () => {
    const split = splitLandedLine(
      { unitPriceBdt: 5000_00, quantity: 1, weightGrams: null },
      rates,
    );

    expect(split.shippingBdt).toBe(475_00);
  });

  it("scales weight with quantity", () => {
    const one = splitLandedLine(
      { unitPriceBdt: 5000_00, quantity: 1, weightGrams: 1000 },
      rates,
    );
    const three = splitLandedLine(
      { unitPriceBdt: 5000_00, quantity: 3, weightGrams: 1000 },
      rates,
    );

    expect(three.shippingBdt).toBe(one.shippingBdt * 3);
  });

  /** A cheap, heavy item would otherwise produce negative goods value. */
  it("never lets freight exceed the price", () => {
    const split = splitLandedLine(
      { unitPriceBdt: 100_00, quantity: 1, weightGrams: 10_000 },
      rates,
    );

    expect(split.shippingBdt).toBe(100_00);
    expect(split.goodsBdt).toBe(0);
    expect(split.dutyBdt).toBe(0);
    expect(split.goodsBdt + split.shippingBdt + split.dutyBdt).toBe(100_00);
  });

  it("handles a free line without dividing by anything", () => {
    const split = splitLandedLine(
      { unitPriceBdt: 0, quantity: 2, weightGrams: 500 },
      rates,
    );

    expect(split).toEqual({
      goodsBdt: 0,
      shippingBdt: 0,
      dutyBdt: 0,
      totalBdt: 0,
    });
  });

  it("keeps the sum exact even where the division does not divide evenly", () => {
    // 999_99 with a 33% duty does not split into whole paisa cleanly.
    for (const price of [999_99, 1_01, 777_77, 12_345]) {
      const split = splitLandedLine(
        { unitPriceBdt: price, quantity: 1, weightGrams: 333 },
        { ...rates, dutyPercent: 33 },
      );

      expect(
        split.goodsBdt + split.shippingBdt + split.dutyBdt,
        `price ${price}`,
      ).toBe(price);
    }
  });

  it("treats a zero duty rate as all goods", () => {
    const split = splitLandedLine(
      { unitPriceBdt: 1000_00, quantity: 1, weightGrams: 0 },
      { ...rates, shippingPerKgBdt: 0, dutyPercent: 0 },
    );

    expect(split.goodsBdt).toBe(1000_00);
    expect(split.dutyBdt).toBe(0);
  });
});

describe("splitting a whole order", () => {
  it("sums the lines and still matches the order total", () => {
    const lines = [
      { unitPriceBdt: 1850_00, quantity: 2, weightGrams: 680 },
      { unitPriceBdt: 32_500_00, quantity: 1, weightGrams: 295 },
      { unitPriceBdt: 499_00, quantity: 3, weightGrams: null },
    ];

    const split = splitLandedOrder(lines, rates);
    const expectedTotal = lines.reduce(
      (sum, line) => sum + line.unitPriceBdt * line.quantity,
      0,
    );

    expect(split.totalBdt).toBe(expectedTotal);
    expect(split.goodsBdt + split.shippingBdt + split.dutyBdt).toBe(
      expectedTotal,
    );
  });

  it("returns zeroes for an empty order", () => {
    expect(splitLandedOrder([], rates)).toEqual({
      goodsBdt: 0,
      shippingBdt: 0,
      dutyBdt: 0,
      totalBdt: 0,
    });
  });
});
