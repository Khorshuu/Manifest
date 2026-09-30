import { labelKey } from "./normalize";

/**
 * Warranty is manual-only (D-128). The one place that decides it.
 *
 * What a warranty covers, for how long and who honours it depends on where
 * and from whom the product is bought. A manufacturer's "3-year warranty"
 * describes the manufacturer's own market, not a product imported and sold by
 * Manifest, so a researched warranty statement is never product knowledge.
 * Only a warranty staff enter in the listing's Warranty & safety section
 * (`products.warranty`) is Manifest's word, and only that may reach a page, a
 * generator or structured data.
 *
 * So, everywhere a researched value could become knowledge or content:
 *
 *  - a candidate label or value that is about a warranty is dropped before it
 *    becomes a claim or an attribute proposal (`isWarrantyCandidate`);
 *  - an established attribute about a warranty is left out of what a
 *    generator is shown (`isWarrantyLabel`), whatever state it is in;
 *  - generated text that mentions a warranty is withheld unless the listing's
 *    manual warranty says there is one (`mentionsWarranty`).
 *
 * The source document itself keeps the words, for provenance.
 */

const WARRANTY_WORDS = /\b(warrant(?:y|ies|ed)|guarantee[ds]?|guaranty)\b/i;
/** "Money-back guarantee", "satisfaction guaranteed": a warranty in all but name. */
const ASSURANCE_WORDS = /\b(money[-\s]?back|satisfaction guaranteed|limited lifetime|lifetime (?:coverage|replacement)|replacement (?:policy|plan)|protection plan|extended (?:coverage|protection)|applecare|care\s?pack)\b/i;

/** Whether a label names a warranty: "Warranty", "Manufacturer warranty", "Guarantee", "Warranty period". */
export function isWarrantyLabel(label: string): boolean {
  const key = labelKey(label);
  return WARRANTY_WORDS.test(key) || ASSURANCE_WORDS.test(key);
}

/** Whether text says anything about a warranty or an equivalent guarantee. */
export function mentionsWarranty(text: string): boolean {
  return WARRANTY_WORDS.test(text) || ASSURANCE_WORDS.test(text);
}

/**
 * Whether a researched candidate is about a warranty and so must not become
 * knowledge: its label names one, or its value states one ("Support: 3-year
 * limited warranty").
 */
export function isWarrantyCandidate(label: string, value: string): boolean {
  return isWarrantyLabel(label) || mentionsWarranty(value);
}
