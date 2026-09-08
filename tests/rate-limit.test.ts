import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, resetRateLimits } from "@/lib/rate-limit";

beforeEach(() => resetRateLimits());

describe("rate limit", () => {
  it("allows up to the limit, then blocks", () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit("key", 3, 1000).allowed).toBe(true);
    }
    expect(checkRateLimit("key", 3, 1000).allowed).toBe(false);
  });

  it("counts each key separately, so one account cannot exhaust another", () => {
    checkRateLimit("a", 1, 1000);
    expect(checkRateLimit("a", 1, 1000).allowed).toBe(false);
    expect(checkRateLimit("b", 1, 1000).allowed).toBe(true);
  });

  it("resets after the window passes", () => {
    const start = 1_000_000;
    checkRateLimit("key", 1, 1000, start);
    expect(checkRateLimit("key", 1, 1000, start + 500).allowed).toBe(false);
    expect(checkRateLimit("key", 1, 1000, start + 1500).allowed).toBe(true);
  });

  it("reports how long to wait when blocked", () => {
    const start = 1_000_000;
    checkRateLimit("key", 1, 10_000, start);
    const blocked = checkRateLimit("key", 1, 10_000, start + 2000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(8);
  });
});
