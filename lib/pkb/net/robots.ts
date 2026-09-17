import { decodeBody, safeFetch, type SafeFetchOptions } from "./safe-fetch";

/**
 * robots.txt (RFC 9309), read before any page on a host is retrieved.
 *
 * A missing file (4xx) allows everything. A file that cannot be read (5xx,
 * timeout, refused) is treated as disallowing everything, as the RFC advises —
 * not being able to ask is not permission.
 */

export const ROBOTS_TOKEN = "manifestknowledgebot";

type Rule = { allow: boolean; pattern: string };

function groupsFor(text: string): Map<string, Rule[]> {
  const groups = new Map<string, Rule[]>();
  let agents: string[] = [];
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent) agents = [];
      agents.push(value.toLowerCase());
      for (const agent of agents) if (!groups.has(agent)) groups.set(agent, []);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === "allow" || field === "disallow") && agents.length > 0) {
      for (const agent of agents) groups.get(agent)!.push({ allow: field === "allow", pattern: value });
    }
  }
  return groups;
}

function matches(pattern: string, path: string): boolean {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    `^${body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`,
  );
  return regex.test(path);
}

/** Whether robots.txt text allows our agent to fetch a path. Longest match wins; allow wins a tie. */
export function robotsAllows(text: string, path: string): boolean {
  const groups = groupsFor(text);
  const rules =
    groups.get(ROBOTS_TOKEN) ?? groups.get("*") ?? [];
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

export type RobotsDecision = { allowed: boolean; reason: string };

/** Checks one address against its host's robots.txt, caching the file per origin. */
export async function checkRobots(
  address: string,
  cache: Map<string, string | null | "unreachable">,
  options: SafeFetchOptions = {},
): Promise<RobotsDecision> {
  const url = new URL(address);
  const origin = url.origin;
  if (!cache.has(origin)) {
    const result = await safeFetch(`${origin}/robots.txt`, {
      ...options,
      maxBytes: 512 * 1024,
      timeoutMs: Math.min(options.timeoutMs ?? 8_000, 8_000),
      acceptTypes: ["text/plain", "text/html", "application/octet-stream"],
    });
    if (result.ok) cache.set(origin, decodeBody(result.body, result.charset));
    else if (result.code === "HTTP_STATUS" && result.status !== undefined && result.status >= 400 && result.status < 500) {
      cache.set(origin, null);
    } else cache.set(origin, "unreachable");
  }
  const text = cache.get(origin);
  if (text === "unreachable") return { allowed: false, reason: "robots.txt could not be read, so nothing on this host is retrieved" };
  if (text === null || text === undefined) return { allowed: true, reason: "no robots.txt" };
  return robotsAllows(text, `${url.pathname}${url.search}`)
    ? { allowed: true, reason: "allowed by robots.txt" }
    : { allowed: false, reason: "disallowed by robots.txt" };
}
