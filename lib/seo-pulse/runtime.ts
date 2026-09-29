import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { DEFAULT_STALE_MINUTES, type JobPolicy } from "@/lib/jobs/runner";
import { getSeoPulseConfig } from "./config";
import { getSeoDataProvider } from "./providers/data";
import { getIntelligenceProvider } from "./providers/intelligence";

/**
 * Where a SeoPulse run executes, and how to tell a slow run from a dead one
 * (D-127).
 */

/** The job that finishes a queued run. */
export const SEO_RESEARCH_JOB = "seo.research_product";

export function seoResearchJobKey(runId: string): string {
  return `seo.research:${runId}`;
}

/**
 * A run done inside the request (the rules generator) finishes in seconds.
 * One still `running` this long after it started, with no job behind it, was
 * abandoned by a request that died.
 */
export const INLINE_RUN_WINDOW_MS = 3 * 60_000;

/** Whether a run would call out to a paid or remote service. */
export function usesExternalProviders(): boolean {
  const config = getSeoPulseConfig();
  const ai = config.SEO_PULSE_AI_PROVIDER === "anthropic" && Boolean(config.ANTHROPIC_API_KEY);
  return ai || getSeoDataProvider() !== null;
}

/**
 * Whether a run must be queued for a worker rather than done inside the
 * request that asked for it.
 *
 * Two different reasons, kept apart: a remote service may be slow or rate
 * limited (finding F4), and a local model is slow by nature — minutes per
 * answer on ordinary hardware, and one at a time (D-127). A local model is
 * not an "external provider"; it is background work. Only the rules
 * generator, which answers in milliseconds, still runs inline.
 */
export function requiresBackgroundExecution(): boolean {
  return getIntelligenceProvider().usesLocalAi === true || usesExternalProviders();
}

/**
 * Where a `running` run stands:
 *
 *  - `queued` — its job is waiting, usually for the local-AI slot;
 *  - `generating` — a worker has it and has shown progress recently;
 *  - `stalled` — a worker had it but has shown no progress for longer than
 *    the job's own stale window; job recovery will hand it to another worker,
 *    so it is still not a reason to start a second generation;
 *  - `inline` — done inside a request, recently started;
 *  - `abandoned` — nothing will ever finish it: its job is dead or gone, or
 *    an inline run outlived any request.
 */
export type SeoRunPhase = "queued" | "generating" | "stalled" | "inline" | "abandoned";

export type SeoRunJob = { status: string; lockedAt: Date | null } | null;

/** Pure, so the thresholds are tested with a fake clock. */
export function seoRunPhase(
  run: { createdAt: Date },
  job: SeoRunJob,
  policy: JobPolicy | undefined,
  now: number = Date.now(),
): SeoRunPhase {
  if (!job) return now - run.createdAt.getTime() <= INLINE_RUN_WINDOW_MS ? "inline" : "abandoned";
  if (job.status === "queued") return "queued";
  if (job.status === "running") {
    const staleAfterMs = (policy?.staleAfterMinutes ?? DEFAULT_STALE_MINUTES) * 60_000;
    return job.lockedAt && now - job.lockedAt.getTime() > staleAfterMs ? "stalled" : "generating";
  }
  // succeeded with the run still running cannot normally happen; dead means
  // no worker will pick it up again.
  return "abandoned";
}

/** Whether a phase means the run will still finish on its own. */
export function isLive(phase: SeoRunPhase): boolean {
  return phase !== "abandoned";
}

/** The phase of a stored run, reading its job. */
export async function loadSeoRunPhase(
  run: { id: string; createdAt: Date },
  policy: JobPolicy | undefined,
  now: number = Date.now(),
): Promise<SeoRunPhase> {
  const [job] = await db
    .select({ status: jobs.status, lockedAt: jobs.lockedAt })
    .from(jobs)
    .where(eq(jobs.dedupeKey, seoResearchJobKey(run.id)))
    .limit(1);
  return seoRunPhase(run, job ?? null, policy, now);
}
