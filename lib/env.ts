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
   * Connection pool size. The development database server (PGlite over TCP)
   * serves one connection at a time, so local runs set this to 1.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  SESSION_SECRET: z.string().min(32),
  /**
   * Login attempt ceilings per 15-minute window. The per-account limit is the
   * meaningful one; the per-IP ceiling is high because offices, campuses and
   * mobile carriers put many legitimate users behind one address.
   */
  LOGIN_RATE_LIMIT_PER_ACCOUNT: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(60),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PAYMENT_PROVIDER: z.enum(["mock", "sslcommerz"]).default("mock"),
  SHIPPING_PROVIDER: z.enum(["mock", "courier"]).default("mock"),
  NOTIFICATION_PROVIDER: z.enum(["mock", "live"]).default("mock"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${missing}`);
  }

  cached = parsed.data;
  return cached;
}
