import { getEnv } from "@/lib/env";
import { describeIntelligenceProvider } from "@/lib/seo-pulse/providers/intelligence";

/**
 * Which optional services product preparation can use (D-123), for the owner
 * who decides whether to pay for them. Only whether each is set up — never a
 * key, never a fragment of one. Staff preparing a product do not need this:
 * "Prepare with SeoPulse" works with all three off.
 */

export type SetupState = "configured" | "missing_key" | "not_configured";

export type ResearchSetupItem = {
  key: "discovery" | "extraction" | "content";
  label: string;
  state: SetupState;
  /** "Configured", "Not configured", "Rules fallback", … */
  status: string;
  detail: string;
};

export function researchSetup(): ResearchSetupItem[] {
  const env = getEnv();
  const discovery: ResearchSetupItem =
    env.PRODUCT_RESEARCH_PROVIDER === "brave"
      ? env.BRAVE_SEARCH_API_KEY
        ? { key: "discovery", label: "Automatic source discovery", state: "configured", status: "Configured", detail: "Finds candidate manufacturer pages by GTIN, model number, or brand and exact name. Every page is still checked against the product before it is used." }
        : { key: "discovery", label: "Automatic source discovery", state: "missing_key", status: "Not configured — key missing", detail: "PRODUCT_RESEARCH_PROVIDER is brave but BRAVE_SEARCH_API_KEY is not set." }
      : { key: "discovery", label: "Automatic source discovery", state: "not_configured", status: "Not configured", detail: "Sources come from the brand registry and the pages staff give. Set PRODUCT_RESEARCH_PROVIDER=brave and BRAVE_SEARCH_API_KEY to find them automatically." };

  const extraction: ResearchSetupItem =
    env.PRODUCT_EXTRACTION_PROVIDER === "anthropic"
      ? env.ANTHROPIC_API_KEY
        ? { key: "extraction", label: "Intelligent document extraction", state: "configured", status: "Configured", detail: `Reads facts written as sentences on pages whose tables say little (${env.PRODUCT_EXTRACTION_MODEL}). Every value is checked against the page's own text; the page is the evidence.` }
        : { key: "extraction", label: "Intelligent document extraction", state: "missing_key", status: "Not configured — key missing", detail: "PRODUCT_EXTRACTION_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set." }
      : { key: "extraction", label: "Intelligent document extraction", state: "not_configured", status: "Not configured", detail: "Pages are read by the structured readers only: tables, specification lists and structured data. Set PRODUCT_EXTRACTION_PROVIDER=anthropic and ANTHROPIC_API_KEY to also read facts written in prose." };

  const ai = describeIntelligenceProvider();
  const content: ResearchSetupItem = ai.paid
    ? { key: "content", label: "SeoPulse content AI", state: "configured", status: "Configured", detail: `${ai.label}. Writes from verified knowledge only; its prose is offered for review before it is used.` }
    : ai.configured
      ? { key: "content", label: "SeoPulse content AI", state: "not_configured", status: "Rules fallback", detail: "Content is written by fixed rules from verified facts. Set SEO_PULSE_AI_PROVIDER=anthropic and ANTHROPIC_API_KEY for written descriptions." }
      : { key: "content", label: "SeoPulse content AI", state: "missing_key", status: "Rules fallback — key missing", detail: ai.note };

  return [discovery, extraction, content];
}
