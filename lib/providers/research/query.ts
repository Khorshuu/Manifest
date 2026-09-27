import { isStrongModelKey } from "@/lib/pkb/identity-labels";
import type { ResearchCandidate, ResearchQuery } from "./types";

/**
 * How any discovery provider asks for a product and orders what comes back
 * (D-114, D-123), shared by the Brave provider and the local one (D-124) so
 * both search on the same conservative identity and neither gives a result
 * trust it has not earned.
 */

/** A name's identity words: lower case, punctuation and trademark signs dropped. */
export function identityWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[™®©℠]/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word && !["the", "and", "with", "for", "of", "a", "an", "by", "in", "new"].includes(word));
}

/**
 * The search, from the strongest identity the product has (D-114, D-123):
 *
 *  1. a GTIN, with the brand;
 *  2. a manufacturer model or part number that can identify a product, with
 *     the brand — never "10" or "(1N)", which would match a thousand pages;
 *  3. the brand and the exact product name, in quotes, with the version that
 *     sets it apart when the name does not already say it — how a shade of a
 *     hair colour or a flavour of a food is identified.
 *
 * Anything vaguer is not searched: no brand, or a name of fewer than three
 * words besides the brand (two with a recorded version). "Revlon hair color"
 * is a category, not a product. A result is only ever an address; it is
 * fetched, matched against this product's identity and reviewed like any
 * other page.
 */
export function buildQuery(query: ResearchQuery): string | null {
  const brand = query.brand?.trim() || null;
  const withBrand = (identifier: string) =>
    [brand, identifier].filter((part): part is string => Boolean(part && part.trim())).join(" ").slice(0, 200);

  if (query.gtins[0]) return withBrand(query.gtins[0]);
  const model = query.modelNumbers.find((value) => isStrongModelKey(value));
  if (model) return withBrand(model);

  if (!brand) return null;
  const brandWords = new Set(identityWords(brand));
  let name = query.name.trim();
  if (name.toLowerCase().startsWith(`${brand.toLowerCase()} `)) name = name.slice(brand.length).trim();
  const nameWords = identityWords(name).filter((word) => !brandWords.has(word));
  const extra = (query.variantValues ?? [])
    .map((value) => value.trim())
    .filter((value) => value && identityWords(value).some((word) => !nameWords.includes(word)));
  if (nameWords.length < 3 && !(nameWords.length >= 2 && (query.variantValues ?? []).length > 0)) return null;
  // The whole name, not a quoted phrase: a manufacturer rarely prints a shop's
  // title verbatim, and every word is still required by the identity check.
  return [brand, name.replace(/["“”]/g, "").replace(/\s[–—-]\s/g, " "), ...extra.slice(0, 1)].join(" ").slice(0, 200);
}

/**
 * Official-looking pages first.
 *
 * "Official" here means only what the Brand Source Registry already says is
 * official for this brand. A domain the registry has not approved is not
 * promoted, and being first in this list gives a page no trust of its own —
 * the registry match is checked again, per page, when it is retrieved.
 */
export function preferOfficial(candidates: ResearchCandidate[], preferredDomains: string[]): ResearchCandidate[] {
  const rank = (candidate: ResearchCandidate): number => {
    try {
      const host = new URL(candidate.url).hostname;
      return preferredDomains.some((domain) => onDomain(host, domain)) ? 0 : 1;
    } catch {
      return 2;
    }
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

/** A host that is the domain or one of its subdomains ("shop.revlon.com" is on "revlon.com"). */
export function onDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const d = domain.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return Boolean(d) && (h === d || h.endsWith(`.${d}`));
}
