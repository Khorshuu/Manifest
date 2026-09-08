import { describe, expect, it } from "vitest";
import {
  buildSku,
  combinationKey,
  countCombinations,
  diffCombinations,
  generateCombinations,
  MAX_COMBINATIONS,
  TooManyCombinationsError,
  type AttributeAxis,
} from "@/lib/catalog/combinations";

const color: AttributeAxis = {
  attributeId: "attr-color",
  name: "Color",
  values: [
    { id: "v-red", value: "Red" },
    { id: "v-blue", value: "Blue" },
  ],
};

const size: AttributeAxis = {
  attributeId: "attr-size",
  name: "Size",
  values: [
    { id: "v-s", value: "Small" },
    { id: "v-m", value: "Medium" },
    { id: "v-l", value: "Large" },
  ],
};

describe("countCombinations", () => {
  it("multiplies the axes", () => {
    expect(countCombinations([color, size])).toBe(6);
  });

  it("is zero with no axes, because there is nothing to combine", () => {
    expect(countCombinations([])).toBe(0);
  });
});

describe("generateCombinations", () => {
  it("produces every pairing exactly once", () => {
    const combinations = generateCombinations([color, size]);
    expect(combinations).toHaveLength(6);
    expect(new Set(combinations.map((c) => c.key)).size).toBe(6);
  });

  it("labels each combination in axis order", () => {
    const combinations = generateCombinations([color, size]);
    expect(combinations[0].label).toBe("Red / Small");
    expect(combinations[5].label).toBe("Blue / Large");
  });

  it("handles a single axis, which is the common case", () => {
    const combinations = generateCombinations([color]);
    expect(combinations.map((c) => c.label)).toEqual(["Red", "Blue"]);
  });

  it("returns nothing when there are no axes", () => {
    expect(generateCombinations([])).toEqual([]);
  });

  /**
   * An axis with no values means there is genuinely no combination to make —
   * silently dropping the axis would produce variants that do not specify it.
   */
  it("returns nothing when any axis has no values", () => {
    expect(
      generateCombinations([color, { ...size, values: [] }]),
    ).toEqual([]);
  });

  it("refuses to generate an unmanageable number of variants", () => {
    const wide: AttributeAxis[] = Array.from({ length: 4 }, (_, axisIndex) => ({
      attributeId: `attr-${axisIndex}`,
      name: `Axis ${axisIndex}`,
      values: Array.from({ length: 6 }, (_, valueIndex) => ({
        id: `v-${axisIndex}-${valueIndex}`,
        value: `Value ${valueIndex}`,
      })),
    }));

    // 6^4 = 1296, above the cap.
    expect(countCombinations(wide)).toBeGreaterThan(MAX_COMBINATIONS);
    expect(() => generateCombinations(wide)).toThrow(TooManyCombinationsError);
  });
});

describe("combinationKey", () => {
  it("does not depend on the order the options are listed in", () => {
    const a = combinationKey([
      { attributeId: "attr-color", attributeValueId: "v-red" },
      { attributeId: "attr-size", attributeValueId: "v-s" },
    ]);
    const b = combinationKey([
      { attributeId: "attr-size", attributeValueId: "v-s" },
      { attributeId: "attr-color", attributeValueId: "v-red" },
    ]);
    expect(a).toBe(b);
  });

  it("distinguishes different values", () => {
    const red = combinationKey([
      { attributeId: "attr-color", attributeValueId: "v-red" },
    ]);
    const blue = combinationKey([
      { attributeId: "attr-color", attributeValueId: "v-blue" },
    ]);
    expect(red).not.toBe(blue);
  });
});

describe("diffCombinations", () => {
  /**
   * Regenerating must not disturb variants that already carry a price,
   * capacity, or orders — only add the ones that are missing.
   */
  it("only creates combinations that do not exist yet", () => {
    const generated = generateCombinations([color]);
    const existingKeys = [generated[0].key];

    const diff = diffCombinations(generated, existingKeys);

    expect(diff.toCreate).toHaveLength(1);
    expect(diff.toCreate[0].label).toBe("Blue");
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.orphanedKeys).toEqual([]);
  });

  it("reports variants whose combination no longer exists, without deleting them", () => {
    const generated = generateCombinations([color]);
    const diff = diffCombinations(generated, ["attr-color:v-green"]);

    expect(diff.orphanedKeys).toEqual(["attr-color:v-green"]);
    expect(diff.toCreate).toHaveLength(2);
  });

  it("creates nothing when everything already exists", () => {
    const generated = generateCombinations([color, size]);
    const diff = diffCombinations(
      generated,
      generated.map((c) => c.key),
    );

    expect(diff.toCreate).toEqual([]);
    expect(diff.unchanged).toHaveLength(6);
  });
});

describe("buildSku", () => {
  it("joins the product code and the chosen values", () => {
    const [combination] = generateCombinations([color]);
    expect(buildSku("CANDY", combination)).toBe("CANDY-RED");
  });

  it("strips punctuation and spaces so the SKU stays scannable", () => {
    const combinations = generateCombinations([
      {
        attributeId: "attr-edition",
        name: "Edition",
        values: [{ id: "v-1", value: "Limited Edition!" }],
      },
    ]);
    expect(buildSku("Candy Box", combinations[0])).toBe("CANDYBOX-LIMITE");
  });

  it("caps each segment so long values do not produce unusable SKUs", () => {
    const combinations = generateCombinations([
      {
        attributeId: "attr-x",
        name: "X",
        values: [{ id: "v-1", value: "A".repeat(40) }],
      },
    ]);
    expect(buildSku("P".repeat(40), combinations[0])).toBe(
      `${"P".repeat(12)}-${"A".repeat(6)}`,
    );
  });
});
