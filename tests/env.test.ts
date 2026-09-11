import { describe, expect, it, vi } from "vitest";
import { getEnv } from "@/lib/env";

describe("env", () => {
  it("fails loudly when required configuration is missing", () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    expect(() => getEnv()).toThrow(/Invalid environment configuration/);
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  });

  /*
   * A host that lists the variable names it found hands the ones without a
   * value through as empty strings. Vercel does this from .env.example, and a
   * build failed on it: "" is not one of the options an enum allows, and
   * coerces to 0 for a count that must be positive.
   */
  it("treats a blank value as unset, so the defaults still apply", async () => {
    const saved = { ...process.env };
    vi.resetModules();

    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/shop";
    process.env.SESSION_SECRET = "s".repeat(32);
    process.env.PAYMENT_PROVIDER = "";
    process.env.SHIPPING_PROVIDER = "";
    process.env.NOTIFICATION_PROVIDER = "";
    process.env.LOGIN_RATE_LIMIT_PER_IP = "";

    const { getEnv: fresh } = await import("@/lib/env");
    const env = fresh();

    expect(env.PAYMENT_PROVIDER).toBe("mock");
    expect(env.SHIPPING_PROVIDER).toBe("mock");
    expect(env.NOTIFICATION_PROVIDER).toBe("mock");
    expect(env.LOGIN_RATE_LIMIT_PER_IP).toBe(60);

    process.env = saved;
  });
});
