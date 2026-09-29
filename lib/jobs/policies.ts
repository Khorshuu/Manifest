import { getProductExtractionProvider } from "@/lib/providers/extraction";
import { localAiRuntime } from "@/lib/providers/local/config";
import { getIntelligenceProvider } from "@/lib/seo-pulse/providers/intelligence";
import { DEFAULT_STALE_MINUTES, type JobPolicies, type JobPolicy } from "./runner";

/** How often a long local-AI job reports that it is still working. */
const HEARTBEAT_MS = 60_000;
/**
 * A research run reads at most a dozen pages, and only the few whose facts
 * are in prose go to the local model; four whole calls' worth of time, each
 * with its queue wait, is a generous bound on a run that is still making
 * progress.
 */
const ENRICHMENT_LOCAL_CALLS = 4;

/**
 * Per-kind runner behaviour, from the providers configured now (D-127).
 *
 * Only local-model work differs from the default, and only while a local
 * model is the one in use, so hosted and rules-only set-ups keep exactly the
 * limits every job had before:
 *
 *  - `seo.research_product` with a local SeoPulse model is a local-AI job:
 *    claimed alone by the local-AI lane, holding the slot, and presumed
 *    abandoned only after one whole call's worth of time (both attempts at
 *    OLLAMA_TIMEOUT_MS, plus the queue wait and a margin) without progress.
 *  - `pkb.enrich_product` with local document extraction stays in ordinary
 *    batches — fetching pages is not what needs serialising, and each model
 *    call inside it waits for the slot itself — but gets the same long
 *    window and a heartbeat, because several pages may each need the model.
 */
export function jobPolicies(): JobPolicies {
  const seo = seoResearchPolicy();
  const enrichment = enrichmentPolicy();
  return {
    ...(seo ? { "seo.research_product": seo } : {}),
    ...(enrichment ? { "pkb.enrich_product": enrichment } : {}),
  };
}

function staleMinutes(ms: number): number {
  return Math.max(DEFAULT_STALE_MINUTES, Math.ceil(ms / 60_000));
}

/**
 * The policy for a SeoPulse research job, or undefined when the SeoPulse
 * model is not local. Separate from the rest so SeoPulse reads only its own
 * provider's settings.
 */
export function seoResearchPolicy(): JobPolicy | undefined {
  if (getIntelligenceProvider().usesLocalAi !== true) return undefined;
  const runtime = localAiRuntime();
  return {
    staleAfterMinutes: staleMinutes(runtime.jobMs),
    heartbeat: { everyMs: HEARTBEAT_MS, maxRuntimeMs: runtime.jobMs },
    localAi: true,
  };
}

/** The policy for a research (enrichment) job, or undefined when extraction is not local. */
export function enrichmentPolicy(): JobPolicy | undefined {
  if (getProductExtractionProvider().key !== "ollama") return undefined;
  const runtime = localAiRuntime();
  return {
    staleAfterMinutes: staleMinutes(runtime.jobMs),
    heartbeat: { everyMs: HEARTBEAT_MS, maxRuntimeMs: runtime.jobMs * ENRICHMENT_LOCAL_CALLS },
  };
}
