/**
 * The sign-in redirect in proxy.ts: a signed-out visitor to the account or
 * admin areas gets a real 307 to sign in, with the page to come back to; a
 * request carrying a session cookie passes through to the page's own check.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { config, proxy } from "../proxy";

describe("proxy", () => {
  it("sends a visitor with no session to sign in, keeping where they were going", () => {
    const response = proxy(new NextRequest("https://shop.example/admin/orders"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/admin/orders");
  });

  it("lets a request with a session cookie through to the page's own check", () => {
    const request = new NextRequest("https://shop.example/account", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=anything` },
    });
    const response = proxy(request);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("covers only the account and admin areas", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*", "/account", "/account/:path*"]);
  });

  /** The proxy repeats the name rather than importing it; this keeps them equal. */
  it("looks for the cookie the application actually sets", () => {
    const source = readFileSync("proxy.ts", "utf8");
    expect(source).toContain(`const SESSION_COOKIE_NAME = "${SESSION_COOKIE_NAME}";`);
  });
});
