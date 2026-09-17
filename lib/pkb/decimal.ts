/**
 * Exact decimal arithmetic for normalized quantities (DECISIONS.md D-065).
 *
 * Unit conversion with JavaScript numbers drifts: 12 ounces is 340.1942775 g,
 * and a float gives 340.19427749999997. A normalized value is compared,
 * filtered and exported, so it must be exact. A decimal is held as an integer
 * number of units of 10^-scale, using BigInt.
 */

export type Decimal = { units: bigint; scale: number };

/** The most decimal places a stored normalized value keeps. */
export const STORED_SCALE = 9;

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** Parses a plain decimal ("12", "-0.5", "340.1942775"). No exponents, no separators. */
export function parseDecimal(text: string): Decimal | null {
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const units = BigInt(`${whole}${fraction}`) * (sign === "-" ? -BigInt(1) : BigInt(1));
  return trim({ units, scale: fraction.length });
}

function pow10(exponent: number): bigint {
  return BigInt(10) ** BigInt(exponent);
}

/** Removes trailing zeros so equal values have one representation. */
function trim(value: Decimal): Decimal {
  let { units, scale } = value;
  while (scale > 0 && units % BigInt(10) === BigInt(0)) {
    units /= BigInt(10);
    scale -= 1;
  }
  if (units === BigInt(0)) scale = 0;
  return { units, scale };
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

export function add(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return trim({ units: x + y, scale });
}

export function subtract(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return trim({ units: x - y, scale });
}

export function multiply(a: Decimal, b: Decimal): Decimal {
  return trim({ units: a.units * b.units, scale: a.scale + b.scale });
}

/** a ÷ b, rounded half away from zero to `scale` places. */
export function divide(a: Decimal, b: Decimal, scale: number): Decimal {
  if (b.units === BigInt(0)) throw new RangeError("Division by zero.");
  // a/b = (a.units / 10^a.scale) / (b.units / 10^b.scale)
  const numerator = a.units * pow10(b.scale + scale + 1);
  const denominator = b.units * pow10(a.scale);
  const quotient = numerator / denominator; // one extra digit, truncated
  const negative = quotient < BigInt(0);
  const magnitude = negative ? -quotient : quotient;
  const rounded = (magnitude + BigInt(5)) / BigInt(10);
  return trim({ units: negative ? -rounded : rounded, scale });
}

/** Rounds half away from zero to at most `scale` places. */
export function round(value: Decimal, scale: number): Decimal {
  if (value.scale <= scale) return value;
  const drop = pow10(value.scale - scale);
  const negative = value.units < BigInt(0);
  const magnitude = negative ? -value.units : value.units;
  const rounded = (magnitude + drop / BigInt(2)) / drop;
  return trim({ units: negative ? -rounded : rounded, scale });
}

export function compare(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** The canonical text of a decimal: no exponent, no trailing zeros. */
export function formatDecimal(value: Decimal): string {
  const { units, scale } = trim(value);
  const negative = units < BigInt(0);
  const digits = (negative ? -units : units).toString();
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

/**
 * The canonical text of a numeric value as the database returns it, which
 * keeps the scale it was written with ("1000.0"). Null when not a decimal.
 */
export function canonicalNumber(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const parsed = parseDecimal(String(text));
  return parsed ? formatDecimal(parsed) : null;
}
