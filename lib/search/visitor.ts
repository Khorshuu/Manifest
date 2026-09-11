import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { getEnv } from "@/lib/env";

/**
 * Who is searching, as far as analytics needs to know: a keyed hash of the
 * connection and the browser that changes every day.
 *
 * It is enough to count distinct people and to stop one person's repeated
 * searches looking like a trend. It is not enough to follow anyone — it rotates
 * at midnight, it is keyed with a server secret so it cannot be recomputed
 * from an address, and no account id is stored beside it (docs/SECURITY.md).
 */
export function visitorHash(
  ip: string,
  agent: string,
  now: Date,
  secret: string,
): string {
  const day = now.toISOString().slice(0, 10);
  return createHmac("sha256", secret)
    .update(`search-visitor|${day}|${ip}|${agent}`)
    .digest("hex")
    .slice(0, 32);
}

export async function currentVisitorHash(now = new Date()): Promise<string> {
  const list = await headers();
  const ip = (
    list.get("x-forwarded-for")?.split(",")[0] ??
    list.get("x-real-ip") ??
    ""
  ).trim();

  return visitorHash(
    ip,
    list.get("user-agent") ?? "",
    now,
    getEnv().SESSION_SECRET,
  );
}

/**
 * A prefetch is the router warming a page nobody asked for yet. Counting it as
 * a search would let a link to "/search?q=…" sitting on a page inflate that
 * query's popularity every time the page was viewed.
 */
export async function isPrefetchRequest(): Promise<boolean> {
  const list = await headers();
  return (
    list.get("next-router-prefetch") === "1" ||
    list.get("purpose") === "prefetch" ||
    (list.get("sec-purpose") ?? "").includes("prefetch")
  );
}

/** Half-hour windows, aligned to absolute time so every process agrees. */
export function analyticsWindow(now: Date): Date {
  const size = 30 * 60 * 1000;
  return new Date(Math.floor(now.getTime() / size) * size);
}
