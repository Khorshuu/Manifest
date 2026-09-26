import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pkbFamilies, pkbProducts, type PkbProviderState } from "@/db/schema";
import { logEvent } from "@/lib/observability/log";
import { getProductExtractionProvider } from "@/lib/providers/extraction";
import type { Extraction } from "./extract";
import { resolveFamilySchema } from "./families";
import { extractionUsefulness, groundCandidates, mergeGroundedPairs, type GroundingRejection } from "./grounding";
import type { ProductIdentity } from "./resolution";

/**
 * The optional second reading of a retrieved document (D-123).
 *
 * Order, always: the deterministic readers first; then, only when what they
 * found is thin and the document has text to read, the configured extraction
 * provider; then the deterministic grounding checks; then the surviving
 * candidates join the deterministic pairs and go through exactly the same
 * evidence → claim / proposal → review path. Nothing here writes, nothing
 * here decides, and with no provider configured the extraction comes back
 * unchanged.
 *
 * Runs outside any transaction: it may wait on a network call.
 */

const MAX_CANDIDATES = 40;

export type AssistOutcome = {
  extraction: Extraction;
  /** Reported on the enrichment run beside discovery, so a person can see what ran. Null when not needed. */
  state: PkbProviderState | null;
  grounded: number;
  rejected: Partial<Record<GroundingRejection, number>>;
};

export async function assistExtraction(
  identity: ProductIdentity,
  extraction: Extraction,
  context: {
    url: string | null;
    title: string | null;
    /** The name of this product's version on a page selling several, or null. */
    version: { multiVersion: boolean; ours: string[] | null };
  },
): Promise<AssistOutcome> {
  const unchanged: AssistOutcome = { extraction, state: null, grounded: 0, rejected: {} };
  const usefulness = extractionUsefulness(extraction);
  if (!usefulness.needsAssistance) return unchanged;

  const provider = getProductExtractionProvider();
  const label = `extraction:${provider.key}`;
  const [product] = await db
    .select({ familyId: pkbProducts.familyId, familyName: pkbFamilies.name })
    .from(pkbProducts)
    .leftJoin(pkbFamilies, eq(pkbFamilies.id, pkbProducts.familyId))
    .where(eq(pkbProducts.id, identity.pkbProductId));
  const schema = product?.familyId ? await resolveFamilySchema(db, product.familyId) : [];

  let result;
  try {
    result = await provider.extract({
      product: {
        name: identity.name,
        brand: identity.brands[0]?.name ?? null,
        family: product?.familyName ?? null,
        variant: context.version.ours?.join(", ") ?? null,
      },
      document: { url: context.url, title: context.title, text: extraction.text },
      knownLabels: schema.map((attribute) => attribute.definition.label),
      maxCandidates: MAX_CANDIDATES,
    });
  } catch (error) {
    logEvent("warn", "pkb.extraction_provider_failed", { error: error instanceof Error ? error.message : String(error) });
    return { ...unchanged, state: { provider: label, status: "FAILED", message: "Intelligent extraction failed; the structured reading was used on its own." } };
  }

  if (result.status !== "OK") {
    return { ...unchanged, state: { provider: label, status: result.status, message: result.message } };
  }

  const report = groundCandidates(result.candidates, {
    text: extraction.text,
    versions: context.version.multiVersion ? { ours: context.version.ours } : null,
  });
  const rejected: AssistOutcome["rejected"] = {};
  for (const entry of report.rejected) rejected[entry.reason] = (rejected[entry.reason] ?? 0) + 1;
  const pairs = mergeGroundedPairs(extraction.pairs, report.grounded);
  logEvent("info", "pkb.extraction_assisted", {
    provider: provider.key,
    candidates: result.candidates.length,
    grounded: report.grounded.length,
    rejected,
  });
  return {
    extraction: { ...extraction, pairs },
    grounded: report.grounded.length,
    rejected,
    state: {
      provider: label,
      status: "OK",
      message: `${result.candidates.length} read from the page, ${report.grounded.length} confirmed against its text, ${report.rejected.length} discarded.`,
    },
  };
}
