/**
 * proxy.ts: cross-site mutations refused, a nonce Content-Security-Policy on
 * every page, and a real 307 to sign in for signed-out visitors to the account
 * and admin areas.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { contentSecurityPolicy, isCrossSiteMutation, proxy } from "../proxy";

const site = "https://shop.example";

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`${site}${path}`, {
    method: init.method ?? "GET",
    headers: { host: "shop.example", ...init.headers },
  });
}

describe("cross-site mutations", () => {
  it("refuses a POST from another origin", () => {
    const response = proxy(request("/api/cart", { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(response.status).toBe(403);
  });

  it("refuses a POST the browser marks cross-site, even without an Origin", () => {
    expect(isCrossSiteMutation(request("/api/checkout", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }))).toBe(true);
  });

  it("refuses a malformed Origin", () => {
    expect(isCrossSiteMutation(request("/api/cart", { method: "DELETE", headers: { origin: "null" } }))).toBe(true);
  });

  it("allows a POST from this site", () => {
    expect(isCrossSiteMutation(request("/api/cart", { method: "POST", headers: { origin: site } }))).toBe(false);
    expect(isCrossSiteMutation(request("/api/cart", { method: "PATCH", headers: { "sec-fetch-site": "same-origin" } }))).toBe(false);
  });

  it("does not interfere with reads", () => {
    expect(isCrossSiteMutation(request("/api/search/suggest?q=a", { headers: { origin: "https://evil.example" } }))).toBe(false);
  });

  it("leaves signed webhooks and the scheduler to prove themselves", () => {
    const headers = { origin: "https://payments.example" };
    expect(isCrossSiteMutation(request("/api/webhooks/payments/mock", { method: "POST", headers }))).toBe(false);
    expect(isCrossSiteMutation(request("/api/cron/jobs", { method: "POST", headers }))).toBe(false);
  });
});

describe("content security policy", () => {
  it("gives each page its own nonce and no unsafe-inline scripts", () => {
    const first = proxy(request("/")).headers.get("content-security-policy")!;
    const second = proxy(request("/")).headers.get("content-security-policy")!;
    expect(first).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(first).not.toBe(second);
    expect(contentSecurityPolicy("abc", true)).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(contentSecurityPolicy("abc", true)).not.toContain("unsafe-eval");
  });

  it("does not put a page policy on API responses", () => {
    expect(proxy(request("/api/search/popular")).headers.get("content-security-policy")).toBeNull();
  });
});

describe("signed-in areas", () => {
  it("sends a visitor with no session to sign in, keeping where they were going", () => {
    const response = proxy(request("/admin/orders"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/admin/orders");
  });

  it("lets a request with a session cookie through to the page's own check", () => {
    const response = proxy(request("/account", { headers: { cookie: `${SESSION_COOKIE_NAME}=anything` } }));
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect elsewhere on the site", () => {
    expect(proxy(request("/administration-tips")).headers.get("location")).toBeNull();
  });

  /** The proxy repeats the name rather than importing it; this keeps them equal. */
  it("looks for the cookie the application actually sets", () => {
    const source = readFileSync("proxy.ts", "utf8");
    expect(source).toContain(`const SESSION_COOKIE_NAME = "${SESSION_COOKIE_NAME}";`);
  });
});

describe("request ids", () => {
  it("gives every response an id, pages and API alike", () => {
    const page = proxy(request("/")).headers.get("x-request-id");
    const api = proxy(request("/api/search/popular")).headers.get("x-request-id");
    expect(page).toMatch(/^[0-9a-f-]{36}$/);
    expect(api).toMatch(/^[0-9a-f-]{36}$/);
    expect(page).not.toBe(api);
  });

  it("keeps a well-formed id from the hosting layer, and replaces a malformed one", () => {
    expect(proxy(request("/", { headers: { "x-vercel-id": "iad1::abcd1234-5678" } })).headers.get("x-request-id")).toBe(
      "iad1::abcd1234-5678",
    );
    expect(proxy(request("/", { headers: { "x-request-id": "<script>" } })).headers.get("x-request-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("puts the id on refusals too", () => {
    const refused = proxy(request("/api/cart", { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(refused.headers.get("x-request-id")).toBeTruthy();
  });
});
