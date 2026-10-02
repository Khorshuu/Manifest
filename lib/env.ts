import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z
    .string()
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres:// connection string.",
    ),
  /**
   * Connections per server instance. Unset, it is 3 on Vercel and 10
   * elsewhere (db/connection.ts): on serverless hosts the total is this times
   * the number of instances, so it stays small and a pooler absorbs spikes.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().optional(),
  /**
   * Named prepared statements. "auto" turns them off behind a Neon "-pooler"
   * address, where a transaction pooler may run each statement on a different
   * server connection.
   */
  DATABASE_PREPARE: z.enum(["auto", "on", "off"]).default("auto"),
  SESSION_SECRET: z.string().min(32),
  /**
   * Login attempt ceilings per 15-minute window. The per-account limit is the
   * meaningful one; the per-IP ceiling is high because offices, campuses and
   * mobile carriers put many legitimate users behind one address.
   */
  LOGIN_RATE_LIMIT_PER_ACCOUNT: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(60),
  /**
   * Second-factor attempt ceilings per 15-minute window. Six digits are
   * guessable at scale, so the per-account ceiling is deliberately tight. The
   * per-address one exists for the same reason as the login one — many
   * legitimate people share an address — and is separately configurable because
   * a test suite signing in as a dozen accounts from one address is otherwise
   * indistinguishable from an attack.
   */
  TWO_FACTOR_RATE_LIMIT_PER_ACCOUNT: z.coerce.number().int().positive().default(10),
  TWO_FACTOR_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(30),
  /**
   * Public search ceilings, per visitor: suggestions per 10 seconds and result
   * clicks per minute. Counted in memory per instance (lib/search/throttle.ts).
   */
  SEARCH_SUGGEST_LIMIT: z.coerce.number().int().positive().default(40),
  SEARCH_CLICK_LIMIT: z.coerce.number().int().positive().default(30),
  /**
   * Hourly ceilings on public writes (lib/http/throttle.ts). Checkout matters
   * most: an unpaid order holds its preorder places for the unpaid window, so
   * unlimited orders from one address could empty a batch.
   */
  CHECKOUT_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(20),
  CHECKOUT_RATE_LIMIT_PER_EMAIL: z.coerce.number().int().positive().default(10),
  REGISTER_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(10),
  ORDER_LOOKUP_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(30),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PAYMENT_PROVIDER: z.enum(["mock", "sslcommerz"]).default("mock"),
  SHIPPING_PROVIDER: z.enum(["mock", "courier"]).default("mock"),
  /** `smtp` sends real email and reads its own settings (lib/providers/notification/config.ts, D-132). */
  NOTIFICATION_PROVIDER: z.enum(["mock", "smtp"]).default("mock"),
  /**
   * Automatic source discovery for the knowledge base; `none` is the default
   * and a fully supported setting (A-6). `brave` adds discovery of candidate
   * addresses through the Brave Search API and needs BRAVE_SEARCH_API_KEY;
   * without the key the provider reports UNAVAILABLE and the pipeline carries
   * on with the registry, staff URLs and provided documents. `local` (D-124)
   * needs no key: it reads the sitemaps of the brand's approved official
   * domains and, when SEARXNG_BASE_URL points at a SearXNG instance on this
   * computer, searches through it (lib/providers/local/config.ts).
   */
  PRODUCT_RESEARCH_PROVIDER: z.enum(["none", "brave", "local"]).default("none"),
  /** Only read when PRODUCT_RESEARCH_PROVIDER=brave. Never committed. */
  BRAVE_SEARCH_API_KEY: z.string().min(8).optional(),
  /**
   * Source-grounded reading of a retrieved page whose facts are in prose
   * rather than tables (D-123). `none` is the default and fully supported:
   * the deterministic readers run exactly as before. `anthropic` asks Claude
   * to point at what the page says — every answer is checked against the
   * page's own text before it can become even a proposal — and needs
   * ANTHROPIC_API_KEY. `ollama` (D-124) does the same with a model running on
   * this computer through Ollama, with no key and no cloud fallback. Neither
   * browses, and neither decides a fact.
   */
  PRODUCT_EXTRACTION_PROVIDER: z.enum(["none", "anthropic", "ollama"]).default("none"),
  PRODUCT_EXTRACTION_MODEL: z.string().min(1).default("claude-opus-5"),
  /** Shared with SEO Pulse's content generator. Never committed. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /**
   * Shared secret the payment provider signs webhooks with. Without it every
   * webhook is refused, which is the safe failure.
   */
  PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
  // SEO Pulse reads its own variables in lib/seo-pulse/config.ts.
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;

  /*
   * A variable set to an empty string means "not set", not "invalid". A host
   * that lists the names it found — Vercel does, from .env.example — hands
   * every one of them through as "", which would otherwise fail the enums and
   * the numbers before the defaults below could apply.
   */
  const supplied = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, process.env[key]?.trim() || undefined]),
  );

  const parsed = schema.safeParse(supplied);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${missing}`);
  }

  cached = parsed.data;
  return cached;
}
