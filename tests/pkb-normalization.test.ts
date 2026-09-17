/**
 * Product Knowledge Base normalization (DECISIONS.md D-065): units, numbers,
 * dates, enums, identifiers. Pure functions, no database.
 */
import { describe, expect, it } from "vitest";
import { add, canonicalNumber, divide, formatDecimal, parseDecimal, round } from "@/lib/pkb/decimal";
import { gtinCheckDigitValid, modelKey, normalizeIdentifier } from "@/lib/pkb/identifiers";
import {
  brandKey,
  keyFromLabel,
  labelKey,
  normalizeValue,
  parseIsoDate,
  type DefinitionShape,
} from "@/lib/pkb/normalize";
import { findUnit, fromCanonical, parseQuantity, parseQuantityRange, UNITS } from "@/lib/pkb/units";

const storage: DefinitionShape = { dataType: "quantity", unitDimension: "data_storage" };
const mass: DefinitionShape = { dataType: "quantity", unitDimension: "mass" };

function quantity(definition: DefinitionShape, raw: string, defaultUnit?: string) {
  const result = normalizeValue(definition, raw, { defaultUnit });
  return result.status === "normalized"
    ? { number: result.value.number, unit: result.value.unit }
    : { reason: result.reason };
}

describe("decimal arithmetic", () => {
  it("is exact where floating point is not", () => {
    const ounces = parseDecimal("12")!;
    const factor = parseDecimal("28.349523125")!;
    expect(formatDecimal({ units: ounces.units * factor.units, scale: factor.scale })).toBe("340.1942775");
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(formatDecimal(add(parseDecimal("0.1")!, parseDecimal("0.2")!))).toBe("0.3");
  });

  it("has one text form per value", () => {
    expect(canonicalNumber("1000.000")).toBe("1000");
    expect(canonicalNumber("0.50")).toBe("0.5");
    expect(canonicalNumber("-0.0")).toBe("0");
    expect(canonicalNumber("abc")).toBeNull();
  });

  it("rounds half away from zero", () => {
    expect(formatDecimal(round(parseDecimal("2.5")!, 0))).toBe("3");
    expect(formatDecimal(round(parseDecimal("-2.5")!, 0))).toBe("-3");
    expect(formatDecimal(divide(parseDecimal("1")!, parseDecimal("3")!, 6))).toBe("0.333333");
    expect(formatDecimal(divide(parseDecimal("2")!, parseDecimal("3")!, 6))).toBe("0.666667");
  });
});

describe("units", () => {
  it("reads storage however it is written", () => {
    const expected = { number: "256000000000", unit: "B" };
    expect(quantity(storage, "256GB")).toEqual(expected);
    expect(quantity(storage, "256 GB")).toEqual(expected);
    expect(quantity(storage, "256 gigabytes")).toEqual(expected);
    expect(quantity(storage, "256 gb")).toEqual(expected);
    expect(quantity(storage, "  256   Gigabytes ")).toEqual(expected);
  });

  it("keeps binary and decimal prefixes apart", () => {
    expect(quantity(storage, "1 GiB")).toEqual({ number: "1073741824", unit: "B" });
    expect(quantity(storage, "1 GB")).toEqual({ number: "1000000000", unit: "B" });
  });

  it("reads mass in any unit into grams, exactly", () => {
    expect(quantity(mass, "1000 g")).toEqual({ number: "1000", unit: "g" });
    expect(quantity(mass, "1 kg")).toEqual({ number: "1000", unit: "g" });
    expect(quantity(mass, "1,000 g")).toEqual({ number: "1000", unit: "g" });
    expect(quantity(mass, "12 oz")).toEqual({ number: "340.1942775", unit: "g" });
    expect(quantity(mass, "2.5 lbs")).toEqual({ number: "1133.980925", unit: "g" });
    expect(quantity(mass, "250g")).toEqual({ number: "250", unit: "g" });
  });

  it("reads screen sizes in inches, including the inch mark", () => {
    const length: DefinitionShape = { dataType: "quantity", unitDimension: "length" };
    expect(quantity(length, '6.1"')).toEqual({ number: "154.94", unit: "mm" });
    expect(quantity(length, "6.1 in")).toEqual({ number: "154.94", unit: "mm" });
  });

  it("converts temperature, an affine unit, both ways", () => {
    const temperature: DefinitionShape = { dataType: "quantity", unitDimension: "temperature" };
    expect(quantity(temperature, "212 °F")).toEqual({ number: "100", unit: "°C" });
    expect(quantity(temperature, "-40 °F")).toEqual({ number: "-40", unit: "°C" });
    expect(quantity(temperature, "0 K")).toEqual({ number: "-273.15", unit: "°C" });
    expect(fromCanonical("100", "°F")).toBe("212");
  });

  it("uses case where case separates two units", () => {
    expect(findUnit("mW")?.code).toBe("mW");
    expect(findUnit("MW")?.code).toBe("MW");
    expect(findUnit("mw")).toBeUndefined();
    expect(findUnit("mAh")?.code).toBe("mAh");
    expect(findUnit("MAH")?.code).toBe("mAh");
  });

  it("refuses rather than guesses", () => {
    // Decimal comma or thousands separator? Cannot tell.
    expect(quantity(mass, "1,5 kg")).toHaveProperty("reason");
    expect(quantity(mass, "about 2 kg")).toHaveProperty("reason");
    expect(quantity(mass, "2 x 500 g")).toHaveProperty("reason");
    expect(quantity(mass, "250")).toEqual({ reason: "no unit given" });
    expect(quantity(mass, "250 ml")).toHaveProperty("reason", '"mL" measures volume, not mass');
    expect(quantity(mass, "250 florps")).toHaveProperty("reason", 'unrecognised unit "florps"');
  });

  it("applies a default unit only to bare numbers", () => {
    const frequency: DefinitionShape = { dataType: "quantity", unitDimension: "frequency" };
    expect(quantity(frequency, "3.4", "GHz")).toEqual({ number: "3400000000", unit: "Hz" });
    expect(quantity(frequency, "3400 MHz", "GHz")).toEqual({ number: "3400000000", unit: "Hz" });
  });

  it("reads ranges with a shared or a per-end unit", () => {
    const range = parseQuantityRange("20 Hz - 20 kHz", "frequency");
    expect(range).toEqual({
      min: expect.objectContaining({ value: "20", unit: "Hz" }),
      max: expect.objectContaining({ value: "20000", unit: "Hz" }),
    });
    expect(parseQuantityRange("5–10 kg", "mass")).toEqual({
      min: expect.objectContaining({ value: "5000" }),
      max: expect.objectContaining({ value: "10000" }),
    });
    expect(parseQuantityRange("-20 to 60 °C", "temperature")).toEqual({
      min: expect.objectContaining({ value: "-20" }),
      max: expect.objectContaining({ value: "60" }),
    });
    expect(parseQuantityRange("10 - 5 kg", "mass")).toHaveProperty("reason");
    expect(parseQuantity("20 Hz - 20 kHz", "frequency")).toHaveProperty("reason");
  });

  it("registers every alias once", () => {
    const seen = new Set<string>();
    for (const unit of UNITS) {
      for (const alias of unit.aliases) {
        expect(seen.has(alias.toLowerCase())).toBe(false);
        seen.add(alias.toLowerCase());
      }
    }
  });
});

describe("other value types", () => {
  it("keeps unknown, false, zero and text apart", () => {
    const flag: DefinitionShape = { dataType: "boolean", unitDimension: null };
    const count: DefinitionShape = { dataType: "number", unitDimension: null };

    const no = normalizeValue(flag, "No");
    expect(no).toEqual({ status: "normalized", value: expect.objectContaining({ boolean: false }) });
    const zero = normalizeValue(count, "0");
    expect(zero).toEqual({ status: "normalized", value: expect.objectContaining({ number: "0" }) });
    // A blank is not false and not zero: it is nothing to store.
    expect(normalizeValue(flag, "  ")).toEqual({ status: "unnormalized", reason: "empty" });
    expect(normalizeValue(count, "")).toEqual({ status: "unnormalized", reason: "empty" });
    expect(normalizeValue(flag, "maybe")).toEqual({ status: "unnormalized", reason: "not a yes or no" });
  });

  it("reads ISO dates at their written precision and nothing else", () => {
    expect(parseIsoDate("2024")).toEqual({ text: "2024", date: "2024-01-01" });
    expect(parseIsoDate("2024-03")).toEqual({ text: "2024-03", date: "2024-03-01" });
    expect(parseIsoDate("2024-03-15")).toEqual({ text: "2024-03-15", date: "2024-03-15" });
    expect(parseIsoDate("2024-02-30")).toBeNull();
    expect(parseIsoDate("03/04/2024")).toBeNull();
    expect(parseIsoDate("March 2024")).toBeNull();
  });

  it("matches enum options by key, label or alias", () => {
    const colour: DefinitionShape = {
      dataType: "enum",
      unitDimension: null,
      options: [{ id: "opt-grey", key: "space_gray", label: "Space Gray", aliases: ["Space Grey"] }],
    };
    for (const written of ["space_gray", "Space Gray", "space grey", "SPACE-GREY"]) {
      expect(normalizeValue(colour, written)).toEqual({
        status: "normalized",
        value: expect.objectContaining({ optionId: "opt-grey" }),
      });
    }
    expect(normalizeValue(colour, "Midnight").status).toBe("unnormalized");
  });

  it("accepts only http(s) links", () => {
    const link: DefinitionShape = { dataType: "url", unitDimension: null };
    expect(normalizeValue(link, "https://Example.com/a#b")).toEqual({
      status: "normalized",
      value: expect.objectContaining({ text: "https://example.com/a" }),
    });
    expect(normalizeValue(link, "javascript:alert(1)").status).toBe("unnormalized");
  });

  it("folds labels, brands and keys conservatively", () => {
    expect(labelKey("Colour:")).toBe("colour");
    expect(labelKey("Café Crème")).toBe("cafe creme");
    expect(brandKey("Bang & Olufsen")).toBe(brandKey("bang and olufsen"));
    expect(brandKey("Delta Pepper Co.")).not.toBe(brandKey("Delta Pepper"));
    expect(brandKey("Northlake Audio")).not.toBe(brandKey("Northline Audio"));
    expect(keyFromLabel("Refresh rate")).toBe("refresh_rate");
    expect(keyFromLabel("5G")).toBe("k_5g");
  });
});

describe("identifiers", () => {
  it("validates GTIN check digits", () => {
    expect(gtinCheckDigitValid("036000291452")).toBe(true); // UPC-A
    expect(gtinCheckDigitValid("036000291453")).toBe(false);
    expect(gtinCheckDigitValid("4006381333931")).toBe(true); // EAN-13
    expect(gtinCheckDigitValid("96385074")).toBe(true); // EAN-8
  });

  it("treats a UPC, its EAN-13 form and its GTIN-14 form as one trade item", () => {
    const upc = normalizeIdentifier("upc", "0 36000 29145 2");
    const ean = normalizeIdentifier("ean", "0036000291452");
    const gtin = normalizeIdentifier("gtin", "00036000291452");
    expect(upc).toMatchObject({ type: "gtin12", validation: "valid", gtin14: "00036000291452" });
    expect(ean).toMatchObject({ type: "gtin13", gtin14: "00036000291452" });
    expect(gtin).toMatchObject({ type: "gtin14", gtin14: "00036000291452" });
  });

  it("keeps an invalid number but never as an identifier of anything", () => {
    const bad = normalizeIdentifier("upc", "036000291453");
    expect(bad).toMatchObject({ validation: "invalid", normalized: null, gtin14: null, raw: "036000291453" });
    expect(normalizeIdentifier("upc", "4006381333931").validation).toBe("invalid"); // 13 digits is not a UPC
  });

  it("reads ISBN-10 and ISBN-13 and gives both the same GTIN", () => {
    const ten = normalizeIdentifier("isbn", "0-306-40615-2");
    const thirteen = normalizeIdentifier("isbn", "978-0-306-40615-7");
    expect(ten).toMatchObject({ type: "isbn10", validation: "valid", gtin14: "09780306406157" });
    expect(thirteen).toMatchObject({ type: "isbn13", validation: "valid", gtin14: "09780306406157" });
    expect(normalizeIdentifier("isbn", "0-306-40615-3").validation).toBe("invalid");
  });

  it("folds model and part numbers for matching and keeps what was written", () => {
    expect(modelKey("WH-1000XM6")).toBe("WH1000XM6");
    expect(modelKey("wh 1000xm6")).toBe("WH1000XM6");
    expect(normalizeIdentifier("mpn", "WH-1000XM6")).toMatchObject({
      raw: "WH-1000XM6",
      normalized: "WH1000XM6",
      validation: "unchecked",
      gtin14: null,
    });
    expect(normalizeIdentifier("asin", "b0abc12345")).toMatchObject({ normalized: "B0ABC12345", validation: "valid" });
    expect(normalizeIdentifier("asin", "B0ABC").validation).toBe("invalid");
  });
});
