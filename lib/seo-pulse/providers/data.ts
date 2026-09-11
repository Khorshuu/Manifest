import { z } from "zod";
import { getSeoPulseConfig } from "../config";
import type { KeywordMetric, ProviderUsage, SerpSnapshot } from "../types";

/**
 * External keyword and search-results data (DECISIONS.md D-038).
 *
 * An interface so SEO Pulse is not welded to one vendor. With no provider
 * configured the answer is "unavailable" — never a number made up to fill the
 * column. Credentials come from the environment and never leave the server.
 */

export interface SeoDataProvider {
  readonly id: string;
  readonly label: string;
  /** Monthly volume, difficulty, competition and CPC per keyword. */
  keywordResearch(keywords: string[]): Promise<KeywordMetric[]>;
  /** The organic results, related searches and questions for one keyword. */
  serpResearch(keyword: string): Promise<SerpSnapshot>;
  /** Requests made and cost reported since the provider was created. */
  usage(): { requests: number; costUsd: number | null };
}

// ------------------------------------------------------------ DataForSEO

const taskResponse = z.object({
  status_code: z.number(),
  status_message: z.string().optional(),
  cost: z.number().optional(),
  tasks: z
    .array(
      z.object({
        status_code: z.number(),
        status_message: z.string().optional(),
        result: z.array(z.unknown()).nullable().optional(),
      }),
    )
    .optional(),
});

const volumeRow = z.object({
  keyword: z.string(),
  search_volume: z.number().nullable().optional(),
  competition: z.union([z.string(), z.number()]).nullable().optional(),
  cpc: z.number().nullable().optional(),
  monthly_searches: z
    .array(z.object({ year: z.number(), month: z.number(), search_volume: z.number().nullable() }))
    .nullable()
    .optional(),
});

const difficultyResult = z.object({
  items: z
    .array(z.object({ keyword: z.string(), keyword_difficulty: z.number().nullable().optional() }))
    .nullable()
    .optional(),
});

const serpItem = z
  .object({
    type: z.string(),
    rank_absolute: z.number().optional(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    items: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

const serpResult = z.object({ items: z.array(serpItem).nullable().optional() });

/**
 * DataForSEO: Google Ads search volume, DataForSEO Labs difficulty and live
 * Google organic results, for the configured location (Bangladesh by default).
 *
 * UNVERIFIED — no credentials were available while this was built. Responses
 * are parsed defensively, and any mismatch surfaces as a provider failure in
 * the run rather than as wrong data.
 */
export class DataForSeoProvider implements SeoDataProvider {
  readonly id = "dataforseo";
  readonly label = "DataForSEO";
  private requests = 0;
  private cost: number | null = null;

  constructor(
    private readonly login: string,
    private readonly password: string,
    private readonly locationCode: number,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  usage() {
    return { requests: this.requests, costUsd: this.cost };
  }

  private async post(path: string, body: unknown): Promise<unknown[]> {
    this.requests += 1;
    const response = await this.fetcher(`https://api.dataforseo.com/v3/${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.login}:${this.password}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([body]),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`DataForSEO answered ${response.status}.`);

    const parsed = taskResponse.parse(await response.json());
    if (parsed.cost !== undefined) this.cost = (this.cost ?? 0) + parsed.cost;
    const task = parsed.tasks?.[0];
    if (!task || task.status_code >= 40000) {
      throw new Error(`DataForSEO: ${task?.status_message ?? parsed.status_message ?? "no result"}`);
    }
    return task.result ?? [];
  }

  async keywordResearch(keywords: string[]): Promise<KeywordMetric[]> {
    if (keywords.length === 0) return [];
    const at = new Date().toISOString();
    const geo = `Google, location ${this.locationCode}, English`;
    const common = { keywords, location_code: this.locationCode, language_code: "en" };

    const volumes = z
      .array(volumeRow)
      .parse(await this.post("keywords_data/google_ads/search_volume/live", common));

    // Difficulty is a second product; a failure there leaves it unavailable.
    const difficulty = new Map<string, number>();
    try {
      const [result] = z
        .array(difficultyResult)
        .parse(await this.post("dataforseo_labs/google/bulk_keyword_difficulty/live", common));
      for (const item of result?.items ?? []) {
        if (typeof item.keyword_difficulty === "number") {
          difficulty.set(item.keyword.toLowerCase(), item.keyword_difficulty);
        }
      }
    } catch {
      // Unavailable, not zero.
    }

    return volumes.map((row) => ({
      keyword: row.keyword,
      searchVolume: row.search_volume ?? null,
      difficulty: difficulty.get(row.keyword.toLowerCase()) ?? null,
      competition: row.competition == null ? null : String(row.competition),
      cpcUsd: row.cpc ?? null,
      trend:
        row.monthly_searches
          ?.filter((entry) => entry.search_volume !== null)
          .map((entry) => ({
            month: `${entry.year}-${String(entry.month).padStart(2, "0")}`,
            volume: entry.search_volume as number,
          }))
          .reverse() ?? null,
      geo,
      source: "DataForSEO — Google Ads search volume",
      researchedAt: at,
    }));
  }

  async serpResearch(keyword: string): Promise<SerpSnapshot> {
    const [result] = z.array(serpResult).parse(
      await this.post("serp/google/organic/live/advanced", {
        keyword,
        location_code: this.locationCode,
        language_code: "en",
        depth: 10,
      }),
    );
    const items = result?.items ?? [];
    const texts = (list: unknown[] | null | undefined) =>
      (list ?? [])
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : entry && typeof entry === "object" && "title" in entry
              ? String((entry as { title: unknown }).title ?? "")
              : "",
        )
        .filter(Boolean);

    return {
      keyword,
      geo: `Google, location ${this.locationCode}, English`,
      source: "DataForSEO — Google organic results",
      researchedAt: new Date().toISOString(),
      results: items
        .filter((item) => item.type === "organic" && item.url && item.title)
        .slice(0, 10)
        .map((item) => ({
          position: item.rank_absolute ?? 0,
          title: item.title ?? "",
          url: item.url ?? "",
          domain: item.domain ?? "",
          snippet: item.description ?? null,
        })),
      relatedSearches: items
        .filter((item) => item.type === "related_searches")
        .flatMap((item) => texts(item.items))
        .slice(0, 10),
      peopleAlsoAsk: items
        .filter((item) => item.type === "people_also_ask")
        .flatMap((item) => texts(item.items))
        .slice(0, 8),
      hasShoppingResults: items.some((item) => /shopping|product/.test(item.type)),
      hasFeaturedSnippet: items.some((item) => item.type === "featured_snippet"),
    };
  }
}

// -------------------------------------------------------------- registry

let override: SeoDataProvider | null | undefined;

/** The configured external provider, or null when none is configured. */
export function getSeoDataProvider(): SeoDataProvider | null {
  if (override !== undefined) return override;
  const env = getSeoPulseConfig();
  if (
    env.SEO_PULSE_DATA_PROVIDER === "dataforseo" &&
    env.DATAFORSEO_LOGIN &&
    env.DATAFORSEO_PASSWORD
  ) {
    return new DataForSeoProvider(
      env.DATAFORSEO_LOGIN,
      env.DATAFORSEO_PASSWORD,
      env.SEO_PULSE_LOCATION_CODE,
    );
  }
  return null;
}

/** What the settings screen shows: configured or not, never the credentials. */
export function describeDataProvider(): {
  configured: boolean;
  /** Whether a run spends money with this provider. */
  paid: boolean;
  label: string;
  note: string;
} {
  const env = getSeoPulseConfig();
  if (env.SEO_PULSE_DATA_PROVIDER === "dataforseo") {
    const ready = Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);
    return {
      configured: ready,
      paid: ready,
      label: "DataForSEO",
      note: ready
        ? `Keyword volume, difficulty and Google results for location ${env.SEO_PULSE_LOCATION_CODE}.`
        : "Selected, but DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set.",
    };
  }
  return {
    configured: false,
    paid: false,
    label: "None",
    note: "No external keyword or search-results provider. Volume, difficulty, CPC and competitor results show as unavailable.",
  };
}

/** Test helper. `null` forces "no provider"; `undefined` restores the default. */
export function setSeoDataProviderForTesting(provider: SeoDataProvider | null | undefined) {
  override = provider;
}

export function unavailableUsage(label: string, message: string): ProviderUsage {
  return {
    id: "external-data",
    label,
    kind: "external_data",
    status: "unavailable",
    message,
    requests: 0,
    estimatedCostUsd: null,
    at: new Date().toISOString(),
  };
}
