/**
 * A value and its unit, written once (D-128).
 *
 * A manufacturer's page usually spells the unit into the value ("2685 MHz",
 * "12GB", "11.80 × 4.73 × 1.9 in"), and extraction also records the unit on
 * its own. Joining the two without looking printed "2685 MHz MHz" and
 * "28 Gbps Gbps" in live acceptance. Every place that joins a value to its unit
 * goes through `valueWithUnit`, and anything already stored twice is repaired
 * by `collapseRepeatedUnits` at the point it is read for display.
 *
 * There is no list of units here. A unit is whatever the caller says it is,
 * compared without regard to case or spacing; a repeated unit is recognised by
 * its position — the same token twice straight after a number — not by
 * knowing its name. Ordinary repeated words are never touched.
 */

/** Letters, symbols and digits a unit token may use: "MHz", "°C", "Ω", "mAh", "m²", "km/h". */
const UNIT_TOKEN = String.raw`[\p{L}µΩ°%][\p{L}\p{N}µΩ°%²³/·.]*`;

/** "2685 MHz MHz" → "2685 MHz"; "28Gbps Gbps" → "28Gbps"; "5 V V V" → "5 V". Only right after a number. */
export function collapseRepeatedUnits(text: string): string {
  const repeated = new RegExp(String.raw`(\p{N}\s*)(${UNIT_TOKEN})((?:\s+\2(?![\p{L}\p{N}]))+)`, "giu");
  return text.replace(repeated, (_match, number: string, unit: string) => `${number}${unit}`);
}

function compact(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/**
 * The value as it should be shown with its unit.
 *
 *  - No unit: the value.
 *  - The value already ends with the unit ("2685 MHz", "12GB", "25 °C"): the
 *    value, repaired if the unit was doubled.
 *  - The value ends in a number ("2685", "3.5", "10–12"): number and unit.
 *  - Anything else ("Blackwell", "7.97 ounces (226 grams)", "10 inches"): the
 *    value, because it already says what it is and appending would corrupt it.
 */
export function valueWithUnit(value: string | null | undefined, unit: string | null | undefined): string {
  const text = collapseRepeatedUnits((value ?? "").trim());
  const suffix = (unit ?? "").trim();
  if (!suffix || !text) return text;
  if (compact(text).endsWith(compact(suffix))) return text;
  return /\p{N}\s*$/u.test(text) ? `${text} ${suffix}` : text;
}
