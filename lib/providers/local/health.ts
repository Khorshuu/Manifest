import { PlaywrightRenderer } from "@/lib/pkb/net/render";
import { searchSearxng } from "@/lib/providers/research/searxng";
import { getLocalServicesConfig, localServiceUrl, ollamaModelFor, type LocalServicesConfig } from "./config";
import { modelInstalled, OllamaClient } from "./ollama";

/**
 * Whether each local service is actually usable right now (D-124), for the
 * owner's setup panel. Bounded (a couple of seconds at most, and a loopback
 * service that is not running refuses at once) and cached briefly, so a page
 * that shows the panel is not slowed by it and nothing is asked on every
 * render. States only: never a document, never a secret.
 */

export type OllamaHealth =
  | { state: "no_model"; model: null; message: string }
  | { state: "refused_address" | "unavailable" | "model_missing"; model: string; message: string }
  | { state: "ready"; model: string; message: string };

export type SearxngHealth = {
  state: "not_configured" | "refused_address" | "unavailable" | "json_disabled" | "ready";
  message: string;
};

export type BrowserHealth = {
  state: "not_configured" | "runtime_missing" | "browser_missing" | "ready";
  message: string;
};

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = compute();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test helper. */
export function clearLocalHealthCache(): void {
  cache.clear();
}

export function checkOllama(model: string | null, config: LocalServicesConfig = getLocalServicesConfig()): Promise<OllamaHealth> {
  return cached(`ollama:${config.OLLAMA_BASE_URL}:${model ?? ""}`, async (): Promise<OllamaHealth> => {
    if (!model) return { state: "no_model", model: null, message: "No local model is chosen. Set OLLAMA_MODEL to a model installed in Ollama." };
    const address = localServiceUrl(config.OLLAMA_BASE_URL, config.OLLAMA_ALLOW_REMOTE);
    if (!address.ok) return { state: "refused_address", model, message: `OLLAMA_BASE_URL is refused: ${address.reason}.` };
    const listed = await OllamaClient.fromConfig(config).models(2_000);
    if (!listed.ok) {
      return listed.kind === "refused_address"
        ? { state: "refused_address", model, message: listed.message }
        : { state: "unavailable", model, message: "Ollama is not running on this computer (or did not answer)." };
    }
    return modelInstalled(model, listed.names)
      ? { state: "ready", model, message: `Ollama is running and ${model} is installed.` }
      : { state: "model_missing", model, message: `Ollama is running, but ${model} is not installed (run: ollama pull ${model}).` };
  });
}

export function checkSearxng(config: LocalServicesConfig = getLocalServicesConfig()): Promise<SearxngHealth> {
  const base = config.SEARXNG_BASE_URL;
  if (!base) return Promise.resolve({ state: "not_configured", message: "SEARXNG_BASE_URL is not set." });
  return cached(`searxng:${base}`, async (): Promise<SearxngHealth> => {
    // SearXNG refuses format=json before searching when JSON is disabled, so this is quick either way.
    const result = await searchSearxng(base, config.SEARXNG_ALLOW_REMOTE, "manifest", 1, { timeoutMs: 2_500 });
    switch (result.status) {
      case "OK":
        return { state: "ready", message: "SearXNG is running with JSON search enabled." };
      case "JSON_DISABLED":
        return { state: "json_disabled", message: result.message };
      case "REFUSED_ADDRESS":
        return { state: "refused_address", message: result.message };
      default:
        return { state: "unavailable", message: "SearXNG is not running on this computer (or did not answer)." };
    }
  });
}

export function checkBrowser(config: LocalServicesConfig = getLocalServicesConfig()): Promise<BrowserHealth> {
  if (config.LOCAL_BROWSER_RENDERER !== "playwright") {
    return Promise.resolve({ state: "not_configured", message: "LOCAL_BROWSER_RENDERER is not set to playwright." });
  }
  return cached("browser", async (): Promise<BrowserHealth> => {
    const ready = await new PlaywrightRenderer().available();
    if (ready.ok) return { state: "ready", message: "Playwright and its Chromium are installed." };
    return /playwright-core/.test(ready.reason)
      ? { state: "runtime_missing", message: `Browser rendering is unavailable: ${ready.reason}.` }
      : { state: "browser_missing", message: `Browser rendering is unavailable: ${ready.reason}.` };
  });
}

export { ollamaModelFor };
