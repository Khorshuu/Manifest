/**
 * Source retrieval network safety (D-073): address policy, host names, pinned
 * DNS, redirects, protocol, port, credentials, timeouts, size caps, content
 * types, decompression bombs and robots.txt.
 *
 * The HTTP tests run a real server on 127.0.0.1. Loopback is refused by the
 * default policy, so those tests pass an explicit test address policy and a
 * resolver that points test host names at the server; separate tests prove the
 * defaults refuse exactly that.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostnameProblem, isPublicAddress } from "@/lib/pkb/net/address";
import { checkRobots, robotsAllows } from "@/lib/pkb/net/robots";
import { safeFetch, type SafeFetchOptions } from "@/lib/pkb/net/safe-fetch";

describe("address policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    // The same three addresses, uncompressed. A check that recognises only the
    // short spellings is a check somebody writes around.
    "0:0:0:0:0:ffff:127.0.0.1",
    "0000:0000:0000:0000:0000:ffff:7f00:0001",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    // The deprecated IPv4-compatible form. This one used to be allowed
    // through: it is not a mapped address, and no blocked IPv6 range covers
    // it, so a retrieval could reach loopback by asking for "::127.0.0.1".
    "::127.0.0.1",
    "::169.254.169.254",
    "0:0:0:0:0:0:7f00:1",
    // An address with a zone index names a local interface.
    "fe80::1%eth0",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2001:db8::1",
    "ff02::1",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "2606:2800:220:1:248:1893:25c8:1946",
    // A public address written as IPv4-mapped. This used to be refused —
    // every mapped address was, whatever it wrapped — which would have shut
    // out a manufacturer's site reachable only that way.
    "::ffff:8.8.8.8",
    "0:0:0:0:0:ffff:808:808",
  ])("allows public %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("refuses an address it cannot make sense of, rather than assuming it is public", () => {
    for (const address of ["", "not-an-address", ":::1", "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1", "12345::"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses internal host names and IP literals before any lookup", () => {
    for (const host of ["localhost", "api.localhost", "printer.local", "metadata.google.internal", "intranet", "127.0.0.1", "[::1]", "db.corp"]) {
      expect(hostnameProblem(host), host).not.toBeNull();
    }
    expect(hostnameProblem("www.sony.com")).toBeNull();
    expect(hostnameProblem("xn--bcher-kva.example")).toBeNull();
  });
});

describe("safe fetch against a real server", () => {
  let server: Server;
  let port: number;
  let hangingRequests = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? "/";
      if (url === "/page") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body><table><tr><th>Weight</th><td>250 g</td></tr></table></body></html>");
      } else if (url === "/to-page") {
        response.writeHead(302, { location: "/page" });
        response.end();
      } else if (url === "/to-internal") {
        response.writeHead(302, { location: "http://intranet.corp/secret" });
        response.end();
      } else if (url === "/to-metadata-host") {
        response.writeHead(301, { location: "http://metadata-looking.example.com/latest/meta-data" });
        response.end();
      } else if (url === "/loop") {
        response.writeHead(302, { location: "/loop" });
        response.end();
      } else if (url === "/big") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("x".repeat(20_000));
      } else if (url === "/bomb") {
        const compressed = zlib.gzipSync(Buffer.alloc(5_000_000, 97));
        response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": compressed.length });
        response.end(compressed);
      } else if (url === "/pdf") {
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end("%PDF-1.7");
      } else if (url === "/forbidden") {
        response.writeHead(403, { "content-type": "text/html" });
        response.end("Please complete the challenge");
      } else if (url === "/hang") {
        hangingRequests += 1;
        // Never answers.
      } else if (url === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("User-agent: *\nDisallow: /private\nAllow: /private/public\n\nUser-agent: ManifestKnowledgeBot\nDisallow: /no-bots\n");
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Test hosts resolve to the local server; the policy admits loopback for the test only. */
  const testing = (): SafeFetchOptions => ({
    resolver: async (host) =>
      host === "metadata-looking.example.com" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
    addressAllowed: (address) => address === "127.0.0.1",
    allowedPorts: [port],
  });
  const at = (path: string, host = "docs.example.com") => `http://${host}:${port}${path}`;

  it("fetches a document through a pinned, vetted address", async () => {
    const result = await safeFetch(at("/page"), testing());
    expect(result).toMatchObject({ ok: true, status: 200, contentType: "text/html", charset: "utf-8" });
    if (result.ok) expect(result.body.toString()).toContain("250 g");
  });

  it("follows a same-site redirect and records it", async () => {
    const result = await safeFetch(at("/to-page"), testing());
    expect(result).toMatchObject({ ok: true, redirects: [at("/page")] });
  });

  it("refuses a redirect to an internal host or to a name that resolves to metadata", async () => {
    expect(await safeFetch(at("/to-internal"), testing())).toMatchObject({ ok: false, code: "PORT" });
    const internal = await safeFetch(at("/to-internal"), { ...testing(), allowedPorts: [port, 80] });
    expect(internal).toMatchObject({ ok: false, code: "HOST" });
    const metadata = await safeFetch(at("/to-metadata-host"), { ...testing(), allowedPorts: [port, 80] });
    expect(metadata).toMatchObject({ ok: false, code: "ADDRESS" });
  });

  it("stops redirect loops", async () => {
    expect(await safeFetch(at("/loop"), testing())).toMatchObject({ ok: false, code: "REDIRECT" });
  });

  it("caps the body, including a decompression bomb", async () => {
    expect(await safeFetch(at("/big"), { ...testing(), maxBytes: 10_000 })).toMatchObject({ ok: false, code: "TOO_LARGE" });
    expect(await safeFetch(at("/bomb"), { ...testing(), maxBytes: 100_000 })).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("refuses document types the extractors do not read", async () => {
    expect(await safeFetch(at("/pdf"), testing())).toMatchObject({ ok: false, code: "CONTENT_TYPE" });
  });

  it("reports access controls instead of working around them", async () => {
    const result = await safeFetch(at("/forbidden"), testing());
    expect(result).toMatchObject({ ok: false, code: "HTTP_STATUS", status: 403 });
    if (!result.ok) expect(result.reason).toMatch(/not worked around/);
  });

  it("times out a site that never answers", async () => {
    const started = Date.now();
    const result = await safeFetch(at("/hang"), { ...testing(), timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, code: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(hangingRequests).toBe(1);
  });

  it("with the default policy, refuses the same server: loopback, odd ports, literals, credentials, protocols", async () => {
    const pointsHome = async () => [{ address: "127.0.0.1", family: 4 as const }];
    expect(await safeFetch("http://docs.example.com/page", { resolver: pointsHome })).toMatchObject({ ok: false, code: "ADDRESS" });
    // A name that resolves to a public and a private address at once is refused whole.
    expect(
      await safeFetch("http://docs.example.com/page", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
      }),
    ).toMatchObject({ ok: false, code: "ADDRESS" });
    expect(await safeFetch(`http://docs.example.com:${port}/page`, { resolver: pointsHome })).toMatchObject({ ok: false, code: "PORT" });
    expect(await safeFetch("http://127.0.0.1/page")).toMatchObject({ ok: false, code: "HOST" });
    expect(await safeFetch("http://user:pass@docs.example.com/")).toMatchObject({ ok: false, code: "CREDENTIALS" });
    expect(await safeFetch("file:///etc/passwd")).toMatchObject({ ok: false, code: "PROTOCOL" });
    expect(await safeFetch("gopher://docs.example.com/")).toMatchObject({ ok: false, code: "PROTOCOL" });
    expect(await safeFetch("not a url")).toMatchObject({ ok: false, code: "INVALID_URL" });
  });

  it("reads robots.txt for our agent, with the most specific rule winning", async () => {
    const cache = new Map();
    expect(await checkRobots(at("/page"), cache, testing())).toMatchObject({ allowed: true });
    expect(await checkRobots(at("/no-bots/page"), cache, testing())).toMatchObject({ allowed: false });
    // Our own group applies instead of "*", so /private is not disallowed for us.
    expect(await checkRobots(at("/private"), cache, testing())).toMatchObject({ allowed: true });
  });

  it("treats unreadable robots.txt as disallowed and a missing one as allowed", async () => {
    const unreachable = await checkRobots("http://docs.example.com/page", new Map(), {
      resolver: async () => [{ address: "10.0.0.1", family: 4 }],
    });
    expect(unreachable).toMatchObject({ allowed: false });
  });
});

describe("robots rules", () => {
  const text = "User-agent: *\nDisallow: /shop\nAllow: /shop/specs\nDisallow: /*.pdf$\n";
  it("applies longest match, wildcards and end anchors", () => {
    expect(robotsAllows(text, "/")).toBe(true);
    expect(robotsAllows(text, "/shop/cart")).toBe(false);
    expect(robotsAllows(text, "/shop/specs/wh-1000xm6")).toBe(true);
    expect(robotsAllows(text, "/manual.pdf")).toBe(false);
    expect(robotsAllows(text, "/manual.pdf?download=1")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /\n", "/anything")).toBe(false);
  });
});
