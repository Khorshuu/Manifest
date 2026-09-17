import {
  add,
  divide,
  formatDecimal,
  multiply,
  parseDecimal,
  round,
  STORED_SCALE,
  subtract,
  type Decimal,
} from "./decimal";

/**
 * The unit registry (DECISIONS.md D-065).
 *
 * Units are code, not data: a conversion factor is a physical constant, and a
 * wrong one would silently corrupt every value of its dimension. Adding a new
 * kind of product never needs a change here unless it measures something no
 * dimension below covers.
 *
 * Every quantity is stored in its dimension's canonical unit, with the text it
 * came from kept beside it. Parsing is deterministic and refuses rather than
 * guesses: "1,5 kg" (a decimal comma or a thousands separator?) and "about
 * 2 kg" are not quantities, they stay raw text.
 */

export const UNIT_DIMENSIONS = [
  "mass",
  "length",
  "volume",
  "data_storage",
  "data_rate",
  "frequency",
  "power",
  "energy",
  "electric_charge",
  "voltage",
  "current",
  "duration",
  "temperature",
  "pixel_count",
  "pressure",
  "speed",
  "rotational_speed",
  "luminous_flux",
  "sound_level",
  "percentage",
] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

type Conversion =
  | { factor: string }
  /** Affine conversions (temperature): to canonical and back. */
  | { toCanonical: (value: Decimal) => Decimal; fromCanonical: (value: Decimal) => Decimal };

export type UnitDefinition = {
  /** Stored in `value_unit` and shown to staff. */
  code: string;
  dimension: UnitDimension;
  conversion: Conversion;
  /** Matched ignoring case. */
  aliases: string[];
  /** Matched exactly — where case separates two units, "mW" and "MW". */
  caseSensitiveAliases?: string[];
};

const d = (text: string): Decimal => parseDecimal(text)!;

const FIVE_NINTHS = { units: BigInt(5), scale: 0 };
const NINE = { units: BigInt(9), scale: 0 };
const THIRTY_TWO = { units: BigInt(32), scale: 0 };
const KELVIN_OFFSET = d("273.15");
const WH_IN_JOULES = d("3600");
const JOULES_IN_KCAL = d("4184");

const f = (factor: string): Conversion => ({ factor });

export const UNITS: UnitDefinition[] = [
  // mass — canonical g
  { code: "g", dimension: "mass", conversion: f("1"), aliases: ["g", "gram", "grams", "gm", "gms"] },
  { code: "mg", dimension: "mass", conversion: f("0.001"), aliases: ["mg", "milligram", "milligrams"] },
  { code: "kg", dimension: "mass", conversion: f("1000"), aliases: ["kg", "kgs", "kilogram", "kilograms", "kilo", "kilos"] },
  { code: "oz", dimension: "mass", conversion: f("28.349523125"), aliases: ["oz", "ounce", "ounces"] },
  { code: "lb", dimension: "mass", conversion: f("453.59237"), aliases: ["lb", "lbs", "pound", "pounds"] },

  // length — canonical mm
  { code: "mm", dimension: "length", conversion: f("1"), aliases: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"] },
  { code: "cm", dimension: "length", conversion: f("10"), aliases: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"] },
  { code: "m", dimension: "length", conversion: f("1000"), aliases: ["m", "meter", "meters", "metre", "metres"] },
  { code: "km", dimension: "length", conversion: f("1000000"), aliases: ["km", "kilometer", "kilometers", "kilometre", "kilometres"] },
  { code: "in", dimension: "length", conversion: f("25.4"), aliases: ["in", "inch", "inches", "\"", "″"] },
  { code: "ft", dimension: "length", conversion: f("304.8"), aliases: ["ft", "foot", "feet"] },

  // volume — canonical mL
  { code: "mL", dimension: "volume", conversion: f("1"), aliases: ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "cc"] },
  { code: "L", dimension: "volume", conversion: f("1000"), aliases: ["l", "liter", "liters", "litre", "litres", "ltr"] },
  { code: "fl oz", dimension: "volume", conversion: f("29.5735295625"), aliases: ["fl oz", "floz", "fluid ounce", "fluid ounces"] },
  { code: "gal", dimension: "volume", conversion: f("3785.411784"), aliases: ["gal", "gallon", "gallons"] },

  // data storage — canonical byte; decimal prefixes as manufacturers use them
  { code: "B", dimension: "data_storage", conversion: f("1"), aliases: ["byte", "bytes"], caseSensitiveAliases: ["B"] },
  { code: "KB", dimension: "data_storage", conversion: f("1000"), aliases: ["kb", "kilobyte", "kilobytes"] },
  { code: "MB", dimension: "data_storage", conversion: f("1000000"), aliases: ["mb", "megabyte", "megabytes"] },
  { code: "GB", dimension: "data_storage", conversion: f("1000000000"), aliases: ["gb", "gigabyte", "gigabytes"] },
  { code: "TB", dimension: "data_storage", conversion: f("1000000000000"), aliases: ["tb", "terabyte", "terabytes"] },
  { code: "KiB", dimension: "data_storage", conversion: f("1024"), aliases: ["kib", "kibibyte", "kibibytes"] },
  { code: "MiB", dimension: "data_storage", conversion: f("1048576"), aliases: ["mib", "mebibyte", "mebibytes"] },
  { code: "GiB", dimension: "data_storage", conversion: f("1073741824"), aliases: ["gib", "gibibyte", "gibibytes"] },
  { code: "TiB", dimension: "data_storage", conversion: f("1099511627776"), aliases: ["tib", "tebibyte", "tebibytes"] },

  // data rate — canonical bit/s
  { code: "bps", dimension: "data_rate", conversion: f("1"), aliases: ["bps", "bit/s"] },
  { code: "kbps", dimension: "data_rate", conversion: f("1000"), aliases: ["kbps", "kbit/s"] },
  { code: "Mbps", dimension: "data_rate", conversion: f("1000000"), aliases: ["mbps", "mbit/s"] },
  { code: "Gbps", dimension: "data_rate", conversion: f("1000000000"), aliases: ["gbps", "gbit/s"] },

  // frequency — canonical Hz
  { code: "Hz", dimension: "frequency", conversion: f("1"), aliases: ["hz", "hertz"] },
  { code: "kHz", dimension: "frequency", conversion: f("1000"), aliases: ["khz", "kilohertz"] },
  { code: "MHz", dimension: "frequency", conversion: f("1000000"), aliases: ["mhz", "megahertz"] },
  { code: "GHz", dimension: "frequency", conversion: f("1000000000"), aliases: ["ghz", "gigahertz"] },

  // power — canonical W
  { code: "W", dimension: "power", conversion: f("1"), aliases: ["w", "watt", "watts"] },
  { code: "mW", dimension: "power", conversion: f("0.001"), aliases: ["milliwatt", "milliwatts"], caseSensitiveAliases: ["mW"] },
  { code: "kW", dimension: "power", conversion: f("1000"), aliases: ["kw", "kilowatt", "kilowatts"] },
  { code: "MW", dimension: "power", conversion: f("1000000"), aliases: ["megawatt", "megawatts"], caseSensitiveAliases: ["MW"] },

  // energy — canonical Wh
  { code: "Wh", dimension: "energy", conversion: f("1"), aliases: ["wh", "watt hour", "watt hours", "watt-hour", "watt-hours"] },
  { code: "mWh", dimension: "energy", conversion: f("0.001"), aliases: [], caseSensitiveAliases: ["mWh"] },
  { code: "kWh", dimension: "energy", conversion: f("1000"), aliases: ["kwh", "kilowatt hour", "kilowatt hours"] },
  {
    code: "J",
    dimension: "energy",
    conversion: {
      toCanonical: (value) => divide(value, WH_IN_JOULES, STORED_SCALE),
      fromCanonical: (value) => multiply(value, WH_IN_JOULES),
    },
    aliases: ["joule", "joules"],
    caseSensitiveAliases: ["J"],
  },
  {
    code: "kcal",
    dimension: "energy",
    conversion: {
      toCanonical: (value) => divide(multiply(value, JOULES_IN_KCAL), WH_IN_JOULES, STORED_SCALE),
      fromCanonical: (value) => divide(multiply(value, WH_IN_JOULES), JOULES_IN_KCAL, STORED_SCALE),
    },
    aliases: ["kcal", "kilocalorie", "kilocalories"],
  },

  // electric charge (battery capacity) — canonical mAh
  { code: "mAh", dimension: "electric_charge", conversion: f("1"), aliases: ["mah", "milliampere hour", "milliampere hours"] },
  { code: "Ah", dimension: "electric_charge", conversion: f("1000"), aliases: ["ah", "ampere hour", "ampere hours"] },

  // voltage — canonical V
  { code: "V", dimension: "voltage", conversion: f("1"), aliases: ["v", "volt", "volts", "vdc", "vac"] },
  { code: "mV", dimension: "voltage", conversion: f("0.001"), aliases: ["millivolt", "millivolts"], caseSensitiveAliases: ["mV"] },
  { code: "kV", dimension: "voltage", conversion: f("1000"), aliases: ["kilovolt", "kilovolts"], caseSensitiveAliases: ["kV"] },

  // current — canonical A
  { code: "A", dimension: "current", conversion: f("1"), aliases: ["amp", "amps", "ampere", "amperes"], caseSensitiveAliases: ["A"] },
  { code: "mA", dimension: "current", conversion: f("0.001"), aliases: ["ma", "milliamp", "milliamps", "milliampere", "milliamperes"] },

  // duration — canonical s
  { code: "s", dimension: "duration", conversion: f("1"), aliases: ["s", "sec", "secs", "second", "seconds"] },
  { code: "ms", dimension: "duration", conversion: f("0.001"), aliases: ["ms", "millisecond", "milliseconds"] },
  { code: "min", dimension: "duration", conversion: f("60"), aliases: ["min", "mins", "minute", "minutes"] },
  { code: "h", dimension: "duration", conversion: f("3600"), aliases: ["h", "hr", "hrs", "hour", "hours"] },
  { code: "d", dimension: "duration", conversion: f("86400"), aliases: ["day", "days"] },

  // temperature — canonical °C, affine
  {
    code: "°C",
    dimension: "temperature",
    conversion: f("1"),
    aliases: ["°c", "ºc", "degc", "deg c", "celsius", "degrees celsius"],
  },
  {
    code: "°F",
    dimension: "temperature",
    conversion: {
      toCanonical: (value) => divide(multiply(subtract(value, THIRTY_TWO), FIVE_NINTHS), NINE, 6),
      fromCanonical: (value) => add(divide(multiply(value, NINE), FIVE_NINTHS, 6), THIRTY_TWO),
    },
    aliases: ["°f", "ºf", "degf", "deg f", "fahrenheit", "degrees fahrenheit"],
  },
  {
    code: "K",
    dimension: "temperature",
    conversion: {
      toCanonical: (value) => subtract(value, KELVIN_OFFSET),
      fromCanonical: (value) => add(value, KELVIN_OFFSET),
    },
    aliases: ["kelvin"],
    caseSensitiveAliases: ["K"],
  },

  // pixel count — canonical px
  { code: "px", dimension: "pixel_count", conversion: f("1"), aliases: ["px", "pixel", "pixels"] },
  { code: "MP", dimension: "pixel_count", conversion: f("1000000"), aliases: ["mp", "megapixel", "megapixels"] },

  // pressure — canonical Pa
  { code: "Pa", dimension: "pressure", conversion: f("1"), aliases: ["pa", "pascal", "pascals"] },
  { code: "kPa", dimension: "pressure", conversion: f("1000"), aliases: ["kpa", "kilopascal", "kilopascals"] },
  { code: "MPa", dimension: "pressure", conversion: f("1000000"), aliases: ["megapascal", "megapascals"], caseSensitiveAliases: ["MPa"] },
  { code: "bar", dimension: "pressure", conversion: f("100000"), aliases: ["bar", "bars"] },
  { code: "psi", dimension: "pressure", conversion: f("6894.757293168"), aliases: ["psi"] },

  // speed — canonical km/h
  { code: "km/h", dimension: "speed", conversion: f("1"), aliases: ["km/h", "kmh", "kph"] },
  { code: "mph", dimension: "speed", conversion: f("1.609344"), aliases: ["mph"] },
  { code: "m/s", dimension: "speed", conversion: f("3.6"), aliases: ["m/s"] },

  // rotational speed — canonical rpm
  { code: "rpm", dimension: "rotational_speed", conversion: f("1"), aliases: ["rpm", "r/min"] },

  // luminous flux — canonical lm
  { code: "lm", dimension: "luminous_flux", conversion: f("1"), aliases: ["lm", "lumen", "lumens"] },

  // sound level — canonical dB (logarithmic; no conversion)
  { code: "dB", dimension: "sound_level", conversion: f("1"), aliases: ["db", "decibel", "decibels"] },

  // percentage — canonical %
  { code: "%", dimension: "percentage", conversion: f("1"), aliases: ["%", "percent", "per cent"] },
];

export const CANONICAL_UNITS: Record<UnitDimension, string> = {
  mass: "g",
  length: "mm",
  volume: "mL",
  data_storage: "B",
  data_rate: "bps",
  frequency: "Hz",
  power: "W",
  energy: "Wh",
  electric_charge: "mAh",
  voltage: "V",
  current: "A",
  duration: "s",
  temperature: "°C",
  pixel_count: "px",
  pressure: "Pa",
  speed: "km/h",
  rotational_speed: "rpm",
  luminous_flux: "lm",
  sound_level: "dB",
  percentage: "%",
};

const byCode = new Map(UNITS.map((unit) => [unit.code, unit]));
const byExactAlias = new Map<string, UnitDefinition>();
const byLowerAlias = new Map<string, UnitDefinition>();

for (const unit of UNITS) {
  for (const alias of unit.caseSensitiveAliases ?? []) {
    if (byExactAlias.has(alias)) throw new Error(`Unit alias "${alias}" is registered twice.`);
    byExactAlias.set(alias, unit);
  }
  for (const alias of unit.aliases) {
    const key = alias.toLowerCase();
    if (byLowerAlias.has(key)) throw new Error(`Unit alias "${alias}" is registered twice.`);
    byLowerAlias.set(key, unit);
  }
}

export function isUnitDimension(value: string): value is UnitDimension {
  return (UNIT_DIMENSIONS as readonly string[]).includes(value);
}

export function unitByCode(code: string): UnitDefinition | undefined {
  return byCode.get(code);
}

/** Tidies a unit as written: "fl. oz." and "fl  oz" are both "fl oz". */
function tidyUnit(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[μµ]/g, "µ")
    .replace(/\.(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The unit a piece of text names, or undefined. */
export function findUnit(text: string): UnitDefinition | undefined {
  const tidy = tidyUnit(text);
  if (!tidy) return undefined;
  return byExactAlias.get(tidy) ?? byLowerAlias.get(tidy.toLowerCase());
}

function toCanonicalValue(value: Decimal, unit: UnitDefinition): Decimal {
  const { conversion } = unit;
  const converted =
    "factor" in conversion
      ? multiply(value, parseDecimal(conversion.factor)!)
      : conversion.toCanonical(value);
  return round(converted, STORED_SCALE);
}

/** Converts a canonical value into another unit of the same dimension, for display. */
export function fromCanonical(value: string, unitCode: string, scale = 6): string | null {
  const unit = byCode.get(unitCode);
  const parsed = parseDecimal(value);
  if (!unit || !parsed) return null;
  const { conversion } = unit;
  const converted =
    "factor" in conversion
      ? divide(parsed, parseDecimal(conversion.factor)!, scale)
      : round(conversion.fromCanonical(parsed), scale);
  return formatDecimal(converted);
}

// ------------------------------------------------------------------ parsing

/** A number as written in product data: "1,000", "12.5", "-20", ".5". */
const NUMBER = String.raw`[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[+-]?\.\d+`;
const QUANTITY = new RegExp(String.raw`^\s*(${NUMBER})\s*([^\d\s+-][^\d]*?)?\s*$`);
const RANGE = new RegExp(
  String.raw`^\s*(${NUMBER})\s*([^\d\s+-][^\d]*?)?\s*(?:-|–|—|to)\s*(${NUMBER})\s*([^\d\s+-][^\d]*?)\s*$`,
  "i",
);

/** A plain number with optional thousands separators, as canonical text. */
export function parseNumberText(text: string): string | null {
  const match = new RegExp(`^\\s*(${NUMBER})\\s*$`).exec(text);
  if (!match) return null;
  const parsed = parseDecimal(match[1].replace(/,/g, "").replace(/^([+-]?)\./, "$10."));
  return parsed ? formatDecimal(round(parsed, STORED_SCALE)) : null;
}

export type ParsedQuantity = {
  /** Canonical value as decimal text. */
  value: string;
  /** Canonical unit code of the dimension. */
  unit: string;
  dimension: UnitDimension;
  /** The unit as it was recognised in the text (before conversion). */
  sourceUnit: string;
};

export type QuantityFailure = { reason: string };

function decimalOf(text: string): Decimal | null {
  return parseDecimal(text.replace(/,/g, "").replace(/^([+-]?)\./, "$10."));
}

function convert(
  numberText: string,
  unitText: string | undefined,
  dimension: UnitDimension,
  defaultUnit: string | undefined,
): ParsedQuantity | QuantityFailure {
  const value = decimalOf(numberText);
  if (!value) return { reason: "not a number" };

  const written = unitText?.trim();
  const unit = written ? findUnit(written) : defaultUnit ? findUnit(defaultUnit) : undefined;
  if (!unit) {
    return { reason: written ? `unrecognised unit "${written}"` : "no unit given" };
  }
  if (unit.dimension !== dimension) {
    return { reason: `"${unit.code}" measures ${unit.dimension.replace(/_/g, " ")}, not ${dimension.replace(/_/g, " ")}` };
  }

  return {
    value: formatDecimal(toCanonicalValue(value, unit)),
    unit: CANONICAL_UNITS[dimension],
    dimension,
    sourceUnit: unit.code,
  };
}

/**
 * A single quantity: "256GB", "256 GB", "256 gigabytes", "1 kg", "6.1\"".
 * `defaultUnit` applies only when the text carries no unit at all — the legacy
 * category specifications stored the unit on the definition, not the value.
 */
export function parseQuantity(
  text: string,
  dimension: UnitDimension,
  options: { defaultUnit?: string } = {},
): ParsedQuantity | QuantityFailure {
  const match = QUANTITY.exec(text.normalize("NFKC"));
  if (!match) return { reason: "not a single quantity" };
  return convert(match[1], match[2], dimension, options.defaultUnit);
}

export type ParsedRange = { min: ParsedQuantity; max: ParsedQuantity };

/** A range: "20 Hz - 20 kHz", "5–10 kg", "-20 to 60 °C". */
export function parseQuantityRange(
  text: string,
  dimension: UnitDimension,
  options: { defaultUnit?: string } = {},
): ParsedRange | QuantityFailure {
  const match = RANGE.exec(text.normalize("NFKC"));
  if (!match) return { reason: "not a range" };
  const [, lowText, lowUnit, highText, highUnit] = match;
  const min = convert(lowText, lowUnit ?? highUnit, dimension, options.defaultUnit);
  if ("reason" in min) return min;
  const max = convert(highText, highUnit, dimension, options.defaultUnit);
  if ("reason" in max) return max;
  const low = parseDecimal(min.value)!;
  const high = parseDecimal(max.value)!;
  if (formatDecimal(subtract(high, low)).startsWith("-")) {
    return { reason: "the range ends below where it starts" };
  }
  return { min, max };
}

export function isQuantityFailure(value: unknown): value is QuantityFailure {
  return typeof value === "object" && value !== null && "reason" in value;
}
