import type { SessionUser } from "@/lib/auth/session";
import { knowledgeSufficiency } from "@/lib/seo-pulse/facts";
import { loadPulseInput } from "@/lib/seo-pulse/service";
import { describeResearchStatus, type ResearchStatus } from "./presentation";
import { getPreparation } from "./service";

/**
 * The research status of one product, for the editor and the staff preview
 * (D-119). Staff only: it reads the preparation run, which needs
 * `catalog.manage`. Sufficiency is the same verdict preparation and Fill with
 * SeoPulse use, so the three never disagree about whether a product has been
 * researched.
 */
export async function productResearchStatus(
  actor: SessionUser | null,
  productId: string,
): Promise<ResearchStatus | null> {
  const [run, input] = await Promise.all([getPreparation(actor, productId), loadPulseInput(productId)]);
  const sufficiency = input ? knowledgeSufficiency(input) : null;
  return describeResearchStatus({
    stage: run?.stage ?? null,
    sufficient: sufficiency?.sufficient ?? false,
    missing: sufficiency?.missing ?? [],
  });
}
