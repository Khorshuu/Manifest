import { createSign } from "node:crypto";
import { z } from "zod";
import { logEvent } from "@/lib/observability/log";
import { DIMENSION_KEYS, type SearchConsoleConnection, type SearchConsoleFetch, type SearchConsoleProvider, type SearchConsoleRequest, type SearchConsoleRow } from "./types";

/**
 * Google Search Console through the Search Analytics API, authenticated with
 * a service account (the supported server-to-server path: a key pair the shop
 * holds, exchanged for a short-lived access token, with the service account
 * added as a user of the property in Search Console).
 *
 * UNVERIFIED — external integration unavailable. No Google credentials were
 * available while this was written, so the request and response shapes follow
 * the published API and every response is parsed defensively: anything that
 * does not match becomes a reported provider failure on the sync, never a
 * stored number.
 *
 * Credentials are read here and nowhere else. They are never logged, never
 * returned from a method, and never reach a page.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const API_ORIGIN = "https://searchconsole.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const REQUEST_TIMEOUT_MS = 30_000;

const configSchema = z.object({
  /** `sc-domain:example.com` or `https://example.com/`, exactly as Search Console spells it. */
  SEARCH_CONSOLE_SITE_URL: z.string().min(3).optional(),
  /** The whole service-account JSON, as one variable. */
  GOOGLE_SEARCH_CONSOLE_CREDENTIALS: z.string().min(1).optional(),
  /** Or the two fields from it, for hosts where a JSON blob is awkward. */
  GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL: z.string().email().optional(),
  GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY: z.string().min(1).optional(),
});

const credentialsSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
});

type Credentials = { clientEmail: string; privateKey: string };

function readConfig() {
  const values = Object.fromEntries(
    Object.keys(configSchema.shape).map((key) => [key, process.env[key]?.trim() || undefined]),
  );
  const parsed = configSchema.safeParse(values);
  if (!parsed.success) {
    // Names only: the values are credentials.
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid Search Console configuration: check ${fields}.`);
  }
  return parsed.data;
}

/** The key pair, from either supported shape, or null when none is set. */
function readCredentials(config: z.infer<typeof configSchema>): Credentials | null {
  if (config.GOOGLE_SEARCH_CONSOLE_CREDENTIALS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.GOOGLE_SEARCH_CONSOLE_CREDENTIALS);
    } catch {
      throw new Error("GOOGLE_SEARCH_CONSOLE_CREDENTIALS is not valid JSON.");
    }
    const result = credentialsSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("GOOGLE_SEARCH_CONSOLE_CREDENTIALS needs client_email and private_key.");
    }
    return { clientEmail: result.data.client_email, privateKey: result.data.private_key };
  }
  if (config.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL && config.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY) {
    return {
      clientEmail: config.GOOGLE_SEARCH_CONSOLE_CLIENT_EMAIL,
      privateKey: config.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY,
    };
  }
  return null;
}

/**
 * A private key pasted into an environment variable usually arrives with its
 * newlines escaped. Restoring them is the difference between a working key and
 * an unreadable one.
 */
function pemFrom(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const rowSchema = z.object({
  keys: z.array(z.string()).optional(),
  clicks: z.number().optional(),
  impressions: z.number().optional(),
  ctr: z.number().optional(),
  position: z.number().optional(),
});

const responseSchema = z.object({ rows: z.array(rowSchema).nullish() });

export class GoogleSearchConsoleProvider implements SearchConsoleProvider {
  readonly key = "google";

  /** Cached access token and the moment it stops being usable. */
  private token: { value: string; expiresAt: number } | null = null;

  connection(): SearchConsoleConnection {
    let config: z.infer<typeof configSchema>;
    let credentials: Credentials | null;
    try {
      config = readConfig();
      credentials = readCredentials(config);
    } catch (error) {
      return {
        status: "NOT_CONFIGURED",
        message: error instanceof Error ? error.message : "Search Console configuration could not be read.",
      };
    }
    if (!config.SEARCH_CONSOLE_SITE_URL) {
      return {
        status: "NOT_CONFIGURED",
        message: "SEARCH_CONSOLE_SITE_URL is not set. It is the property exactly as Search Console spells it.",
      };
    }
    if (!credentials) {
      return {
        status: "NOT_CONFIGURED",
        message:
          "No Search Console credentials are set. Add the service account key as GOOGLE_SEARCH_CONSOLE_CREDENTIALS and grant it access to the property.",
      };
    }
    return { status: "CONFIGURED", property: config.SEARCH_CONSOLE_SITE_URL, account: credentials.clientEmail };
  }

  /** A short-lived access token, re-used until a minute before it expires. */
  private async accessToken(credentials: Credentials): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt > now + 60) return this.token.value;

    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(
      JSON.stringify({
        iss: credentials.clientEmail,
        scope: SCOPE,
        aud: TOKEN_ENDPOINT,
        iat: now,
        exp: now + 3600,
      }),
    );
    let assertion: string;
    try {
      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${claim}`);
      assertion = `${header}.${claim}.${base64url(signer.sign(pemFrom(credentials.privateKey)))}`;
    } catch {
      // The key itself is never quoted, and the library's message ("DECODER
      // routines::unsupported") tells an operator nothing they can act on.
      throw new Error(
        "The Search Console private key could not be read. Check that GOOGLE_SEARCH_CONSOLE_CREDENTIALS holds the whole service-account key, with its newlines intact.",
      );
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // The body can carry the assertion back; only the status is reported.
      throw new Error(`Google refused the credentials (HTTP ${response.status}).`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google returned no access token.");
    this.token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
    return this.token.value;
  }

  async fetchPerformance(request: SearchConsoleRequest): Promise<SearchConsoleFetch> {
    const state = this.connection();
    if (state.status === "NOT_CONFIGURED") return { status: "NOT_CONFIGURED", message: state.message };

    let credentials: Credentials | null;
    try {
      credentials = readCredentials(readConfig());
    } catch (error) {
      return { status: "NOT_CONFIGURED", message: error instanceof Error ? error.message : "Unreadable configuration." };
    }
    if (!credentials) return { status: "NOT_CONFIGURED", message: "No Search Console credentials are set." };

    let token: string;
    try {
      token = await this.accessToken(credentials);
    } catch (error) {
      return { status: "UNAVAILABLE", message: error instanceof Error ? error.message : "Could not authenticate." };
    }

    const url = `${API_ORIGIN}/webmasters/v3/sites/${encodeURIComponent(request.property)}/searchAnalytics/query`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          startDate: request.startDate,
          endDate: request.endDate,
          dimensions: DIMENSION_KEYS[request.dimension],
          rowLimit: request.rowLimit,
          startRow: request.startRow,
          type: "web",
          // Only settled figures: Search Console revises the most recent days,
          // and storing a provisional number as final is how a "decline" is
          // reported for a day that had not finished being counted.
          dataState: "final",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        message: error instanceof Error ? `Search Console did not answer: ${error.message}` : "Search Console did not answer.",
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: "UNAVAILABLE",
        message: `Search Console refused the request (HTTP ${response.status}). Check that the service account is a user of this property.`,
      };
    }
    if (response.status === 429 || response.status >= 500) {
      return { status: "UNAVAILABLE", message: `Search Console is not answering right now (HTTP ${response.status}).` };
    }
    if (!response.ok) {
      return { status: "FAILED", message: `Search Console returned HTTP ${response.status}.` };
    }

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(await response.json());
    } catch {
      await logEvent("warn", "search_console.unexpected_response", { property: request.property });
      return { status: "FAILED", message: "Search Console returned something this shop could not read." };
    }

    const rows: SearchConsoleRow[] = [];
    for (const row of parsed.rows ?? []) {
      const keys = row.keys ?? [];
      const names = DIMENSION_KEYS[request.dimension];
      const at = (name: string) => {
        const index = names.indexOf(name);
        return index >= 0 ? (keys[index] ?? null) : null;
      };
      const date = at("date");
      if (!date) continue;
      rows.push({
        date,
        page: at("page"),
        query: at("query"),
        clicks: Math.max(0, Math.round(row.clicks ?? 0)),
        impressions: Math.max(0, Math.round(row.impressions ?? 0)),
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      });
    }

    // Google pages by row offset and stops returning rows at the end; a full
    // page means there may be more, an under-full one means there is not.
    return { status: "OK", rows, hasMore: (parsed.rows?.length ?? 0) >= request.rowLimit };
  }
}
