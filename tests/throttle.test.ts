/**
 * Public write limits (lib/http/throttle.ts): each key allows its ceiling in a
 * window and then answers 429 with Retry-After, keys do not share a count, and
 * the caller's address comes from the forwarding header.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const forwarded = vi.hoisted(() => ({ value: "203.0.113.7, 10.0.0.1" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": forwarded.value }),
}));

import { allowAttempt, clientAddress, throttle } from "@/lib/http/throttle";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

describe("throttle", () => {
  it("allows the ceiling, then refuses with 429 and Retry-After", async () => {
    const checks = [["checkout:ip:203.0.113.7", 2]] as const;
    expect(await throttle(checks, 3_600_000)).toBeNull();
    expect(await throttle(checks, 3_600_000)).toBeNull();

    const refused = await throttle(checks, 3_600_000, "Too many orders from here in a short time.");
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await refused!.json()).error).toMatch(/Too many orders/);
  });

  it("counts each key separately, and refuses when any one is over", async () => {
    const window = 3_600_000;
    await throttle([["checkout:email:a@example.com", 1]], window);
    expect(await throttle([["checkout:email:b@example.com", 1]], window)).toBeNull();
    const refused = await throttle(
      [
        ["checkout:ip:198.51.100.1", 5],
        ["checkout:email:a@example.com", 1],
      ],
      window,
    );
    expect(refused?.status).toBe(429);
  });

  it("reports allowed attempts for pages the same way", async () => {
    expect(await allowAttempt("order-lookup:ip:1", 1, 3_600_000)).toBe(true);
    expect(await allowAttempt("order-lookup:ip:1", 1, 3_600_000)).toBe(false);
  });

  it("reads the caller's address from the first forwarded hop", async () => {
    expect(await clientAddress()).toBe("203.0.113.7");
  });
});
