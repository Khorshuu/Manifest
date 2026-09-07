import { describe, expect, it } from "vitest";
import { getEnv } from "@/lib/env";

describe("env", () => {
  it("fails loudly when required configuration is missing", () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    expect(() => getEnv()).toThrow(/Invalid environment configuration/);
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  });
});
