import type { ProductResearchProvider, ResearchResult } from "./types";

/**
 * The default: automatic discovery is not set up. Enrichment still runs from
 * the registry, staff URLs, uploads and feeds; the run simply records that
 * discovery was unavailable instead of pretending to have searched.
 */
export class UnconfiguredResearchProvider implements ProductResearchProvider {
  readonly key = "none";

  async findSources(): Promise<ResearchResult> {
    return {
      status: "NOT_CONFIGURED",
      message: "No product research provider is configured. Sources come from the brand registry, staff URLs, uploads and feeds.",
    };
  }
}
