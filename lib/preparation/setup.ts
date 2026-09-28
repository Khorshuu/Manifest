import { getEnv } from "@/lib/env";
import { getLocalServicesConfig, ollamaModelFor } from "@/lib/providers/local/config";
import { checkBrowser, checkOllama, checkSearxng, type OllamaHealth } from "@/lib/providers/local/health";
import { getSeoPulseConfig } from "@/lib/seo-pulse/config";
import { describeIntelligenceProvider } from "@/lib/seo-pulse/providers/intelligence";

/**
 * Which optional services product preparation can use (D-123, D-124), for the
 * owner who sets them up. Only whether each is set up and, for the services
 * on this computer, whether each is running — never a key, never a fragment
 * of one. Staff preparing a product do not need this: "Prepare with SeoPulse"
 * works with every one of them off.
 */

export type SetupState = "configured" | "missing_key" | "not_configured" | "unavailable" | "partial";

export type ResearchSetupItem = {
  key: "discovery" | "extraction" | "content" | "crawler";
  label: string;
  state: SetupState;
  /** "Ready", "Not configured", "Rules mode", "Ollama not running", … */
  status: string;
  detail: string;
};

function ollamaItem(
  key: "extraction" | "content",
  label: string,
  health: OllamaHealth,
  what: string,
  fallback: string,
): ResearchSetupItem {
  switch (health.state) {
    case "ready":
      return { key, label, state: "configured", status: `Ollama ready — ${health.model}`, detail: `${what} Runs on this computer; nothing is sent to a cloud AI service.` };
    case "model_missing":
      return { key, label, state: "unavailable", status: "Configured model not installed", detail: `${health.message} ${fallback}` };
    case "no_model":
      return { key, label, state: "missing_key", status: "No local model chosen", detail: `${health.message} ${fallback}` };
    case "refused_address":
      return { key, label, state: "unavailable", status: "Ollama address refused", detail: `${health.message} ${fallback}` };
    case "unavailable":
      return { key, label, state: "unavailable", status: "Ollama not running", detail: `Start Ollama (ollama serve) on this computer. ${fallback}` };
  }
}

export async function researchSetup(): Promise<ResearchSetupItem[]> {
  const env = getEnv();
  const local = getLocalServicesConfig();
  const pulse = getSeoPulseConfig();

  let discovery: ResearchSetupItem;
  if (env.PRODUCT_RESEARCH_PROVIDER === "local") {
    const searxng = await checkSearxng(local);
    const label = "Local web discovery";
    discovery =
      searxng.state === "ready"
        ? { key: "discovery", label, state: "configured", status: "Ready", detail: "Finds the manufacturer's page in the sitemaps of the brand's approved official domains and through local web search (SearXNG), by GTIN, model number, or brand and exact name. Every page is still checked against the product before it is used." }
        : searxng.state === "not_configured"
          ? { key: "discovery", label, state: "partial", status: "Official-domain sitemaps only", detail: "Reads the sitemaps of the brand's approved official domains. Set SEARXNG_BASE_URL to a SearXNG instance on this computer to also search the web." }
          : {
              key: "discovery",
              label,
              state: "partial",
              status: searxng.state === "json_disabled" ? "SearXNG JSON search disabled" : searxng.state === "refused_address" ? "SearXNG address refused" : "SearXNG not running",
              detail: `${searxng.message} Using official-domain and sitemap discovery only.`,
            };
  } else if (env.PRODUCT_RESEARCH_PROVIDER === "brave") {
    discovery = env.BRAVE_SEARCH_API_KEY
      ? { key: "discovery", label: "Automatic source discovery", state: "configured", status: "Configured (Brave, paid API)", detail: "Finds candidate manufacturer pages by GTIN, model number, or brand and exact name. Every page is still checked against the product before it is used." }
      : { key: "discovery", label: "Automatic source discovery", state: "missing_key", status: "Not configured — key missing", detail: "PRODUCT_RESEARCH_PROVIDER is brave but BRAVE_SEARCH_API_KEY is not set." };
  } else {
    discovery = { key: "discovery", label: "Automatic source discovery", state: "not_configured", status: "Not configured", detail: "Sources come from the brand registry and the pages staff give. Set PRODUCT_RESEARCH_PROVIDER=local to find them in official sitemaps and local web search, at no cost." };
  }

  let extraction: ResearchSetupItem;
  const extractionLabel = "Local intelligent extraction";
  if (env.PRODUCT_EXTRACTION_PROVIDER === "ollama") {
    extraction = ollamaItem(
      "extraction",
      extractionLabel,
      await checkOllama(ollamaModelFor(local, "extraction"), local),
      "Reads facts written as sentences on pages whose tables say little. Every value is checked against the page's own text; the page is the evidence.",
      "Until then pages are read by the structured readers only, and prose is reported as not read.",
    );
  } else if (env.PRODUCT_EXTRACTION_PROVIDER === "anthropic") {
    extraction = env.ANTHROPIC_API_KEY
      ? { key: "extraction", label: "Intelligent document extraction", state: "configured", status: "Configured (Anthropic, paid API)", detail: `Reads facts written as sentences on pages whose tables say little (${env.PRODUCT_EXTRACTION_MODEL}). Every value is checked against the page's own text; the page is the evidence.` }
      : { key: "extraction", label: "Intelligent document extraction", state: "missing_key", status: "Not configured — key missing", detail: "PRODUCT_EXTRACTION_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set." };
  } else {
    extraction = { key: "extraction", label: extractionLabel, state: "not_configured", status: "Not configured", detail: "Pages are read by the structured readers only: tables, specification lists and structured data. Set PRODUCT_EXTRACTION_PROVIDER=ollama and OLLAMA_MODEL to also read facts written in prose, on this computer." };
  }

  let content: ResearchSetupItem;
  const contentLabel = "SeoPulse content AI";
  if (pulse.SEO_PULSE_AI_PROVIDER === "ollama") {
    content = ollamaItem(
      "content",
      contentLabel,
      await checkOllama(ollamaModelFor(local, "seo"), local),
      "Writes descriptions, key features and SEO wording from verified knowledge only, and preparation fills them into fields that are empty or still SeoPulse's own. Staff-written and locked fields are never changed.",
      "Until then content is written by the rules generator, and runs say so.",
    );
  } else {
    const ai = describeIntelligenceProvider();
    content = ai.paid
      ? { key: "content", label: contentLabel, state: "configured", status: "Configured (Anthropic, paid API)", detail: `${ai.label}. Writes from verified knowledge only; its prose is offered for review before it is used.` }
      : ai.configured
        ? { key: "content", label: contentLabel, state: "not_configured", status: "Rules mode", detail: "Content is written by fixed rules from verified facts. Set SEO_PULSE_AI_PROVIDER=ollama and OLLAMA_MODEL for written descriptions from a local model." }
        : { key: "content", label: contentLabel, state: "missing_key", status: "Rules mode — key missing", detail: ai.note };
  }

  const browser = await checkBrowser(local);
  const crawler: ResearchSetupItem =
    browser.state === "ready"
      ? { key: "crawler", label: "Crawler", state: "configured", status: "Static fetch ready · browser renderer ready", detail: "Pages are read with the safe static fetcher first; a page that is only an empty JavaScript shell is rendered in a local Chromium whose every request goes through the same fetcher." }
      : browser.state === "not_configured"
        ? { key: "crawler", label: "Crawler", state: "partial", status: "Static fetch ready · browser renderer off", detail: "Pages are read with the safe static fetcher. Set LOCAL_BROWSER_RENDERER=playwright to render pages that show nothing without JavaScript." }
        : { key: "crawler", label: "Crawler", state: "partial", status: "Static fetch ready · browser renderer not installed", detail: `${browser.message} JavaScript-only pages are read as their static copy, and the run says when rendering might have helped.` };

  return [discovery, extraction, content, crawler];
}
