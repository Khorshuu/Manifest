import { z } from "zod";

/**
 * SEO Pulse's own settings (DECISIONS.md D-038), read separately from
 * lib/env.ts so the feature depends only on the variables it uses.
 *
 * Every one is optional with a safe default: out of the box SEO Pulse runs
 * the free rules generator with no external data provider, so nothing is
 * spent until someone opts in on the server.
 */
const schema = z.object({
  /** "rules" costs nothing; "anthropic" asks Claude and needs ANTHROPIC_API_KEY. */
  SEO_PULSE_AI_PROVIDER: z.enum(["rules", "anthropic"]).default("rules"),
  SEO_PULSE_AI_MODEL: z.string().min(1).default("claude-opus-5"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** External keyword and search-results data. "none" means unavailable. */
  SEO_PULSE_DATA_PROVIDER: z.enum(["none", "dataforseo"]).default("none"),
  DATAFORSEO_LOGIN: z.string().min(1).optional(),
  DATAFORSEO_PASSWORD: z.string().min(1).optional(),
  /** Google Ads location code for keyword data. 2050 is Bangladesh. */
  SEO_PULSE_LOCATION_CODE: z.coerce.number().int().positive().default(2050),
  /** Research runs one staff member may start per hour — a cost ceiling. */
  SEO_PULSE_MAX_RUNS_PER_HOUR: z.coerce.number().int().positive().default(30),
});

export type SeoPulseConfig = z.infer<typeof schema>;

export function getSeoPulseConfig(): SeoPulseConfig {
  // Blank values in an .env file mean "not set", not "set to empty".
  const values = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, process.env[key]?.trim() || undefined]),
  );
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid SEO Pulse configuration: ${issues}`);
  }
  return parsed.data;
}
