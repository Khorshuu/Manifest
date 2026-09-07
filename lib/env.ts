import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
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
