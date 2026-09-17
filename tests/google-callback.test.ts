/**
 * The Google sign-in callback route refuses a handshake it did not start
 * (PRODUCTION-READINESS 18.1): a state that does not match the cookie set when
 * the sign-in began, or a missing verifier, ends at the sign-in page with an
 * error, no session cookie, and no call to Google. Whatever the outcome, the
 * handshake cookies are spent.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
const exchanged = vi.hoisted(() => ({ calls: 0 }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    delete: (name: string) => jar.delete(name),
  }),
}));

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => undefined,
}));

vi.mock("@/lib/auth/google", async (original) => ({
  ...(await original<typeof import("@/lib/auth/google")>()),
  exchangeCodeForProfile: async () => {
    exchanged.calls += 1;
    throw new Error("must not be reached");
  },
}));

import { GET } from "@/app/api/auth/google/callback/route";

const previous = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  jar.clear();
  exchanged.calls = 0;
});

afterAll(() => {
  process.env.GOOGLE_CLIENT_ID = previous.id;
  process.env.GOOGLE_CLIENT_SECRET = previous.secret;
});

function callback(query: string) {
  return GET(new Request(`https://shop.example/api/auth/google/callback?${query}`));
}

function expectRefused(response: Response, reason: string) {
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
  const location = new URL(response.headers.get("location")!);
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("error")).toBe(reason);
  expect(response.headers.get("set-cookie") ?? "").not.toMatch(/session=/);
  expect(exchanged.calls).toBe(0);
}

describe("the Google callback", () => {
  it("refuses a state that does not match the one this browser was given", async () => {
    jar.set("google_oauth_state", "state-issued-to-this-browser");
    jar.set("google_oauth_verifier", "verifier");

    expectRefused(await callback("code=abc&state=state-from-someone-else"), "google-state");
  });

  it("refuses a callback with no handshake in progress", async () => {
    expectRefused(await callback("code=abc&state=anything"), "google-expired");
  });

  it("refuses when the verifier is missing, even with a matching state", async () => {
    jar.set("google_oauth_state", "same");
    expectRefused(await callback("code=abc&state=same"), "google-expired");
  });

  it("treats a cancel as a cancel", async () => {
    jar.set("google_oauth_state", "same");
    jar.set("google_oauth_verifier", "verifier");
    expectRefused(await callback("error=access_denied&state=same"), "google-cancelled");
  });

  it("spends the handshake cookies whatever the outcome", async () => {
    jar.set("google_oauth_state", "one");
    jar.set("google_oauth_verifier", "verifier");
    jar.set("google_oauth_next", "/account");

    await callback("code=abc&state=two");
    expect([...jar.keys()]).toEqual([]);
  });

  it("does not exist when Google is not configured", async () => {
    process.env.GOOGLE_CLIENT_ID = "";
    const response = await callback("code=abc&state=anything");
    expect(response.status).toBe(404);
  });
});
