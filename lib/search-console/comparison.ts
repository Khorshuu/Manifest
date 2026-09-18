import { db } from "@/db";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { Executor } from "@/lib/pkb/common";
import { changeFieldLabel, recentSeoChanges, seoChangesFor, type SeoChange } from "@/lib/seo/history";
import { addDays, daysBetween, isoDay } from "./config";
import { configuredProperty, coverageFor, daysWithData, totalsFor, windowLength, type Totals, type Window } from "./metrics";
import { THRESHOLDS } from "./opportunities";

/**
 * What happened around an SEO change (D-099).
 *
 * This compares the measurements in the window before a change with the
 * window after it, and it says so in exactly those terms. It never says a
 * change caused anything, and the wording is not a matter of taste: a page's
 * clicks move with the season, with stock, with price, with what competitors
 * publish and with whatever Google changed that week. A shop that reads
 * "this change caused traffic to rise" starts making changes for reasons it
 * has not actually measured.
 *
 * So the output is: what the numbers were before, what they were after, and
 * whether there is enough data to say even that. `causation` is a field with
 * one value — "not established" — because it is never anything else here.
 */

export const COMPARISON_VERDICTS = [
  /** Both windows are measured; the difference is stated as an observation. */
  "observed",
  /** The change is too recent for a full window after it. */
  "window_incomplete",
  /** Not enough measured days, or too few impressions to compare. */
  "insufficient_data",
  /** Search Console has no measurements covering the change at all. */
  "not_measured",
] as const;
export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number];

export type ChangeComparison = {
  change: SeoChange;
  verdict: ComparisonVerdict;
  /** What was measured, in plain words. Never a causal claim. */
  observation: string;
  /** Always "not established". Present so no reader has to infer it. */
  causation: "not established";
  /** Why the numbers may have moved for reasons other than this change. */
  confounders: string[];
  before: (Totals & { window: Window }) | null;
  after: (Totals & { window: Window }) | null;
  /** Differences, when both windows exist. */
  delta: { clicks: number; impressions: number; ctr: number; position: number | null } | null;
};

const MIN_IMPRESSIONS_TO_COMPARE = 50;

const CONFOUNDERS = [
  "Other changes to this page in the same period.",
  "Seasonal demand, stock and price.",
  "What Google changed in its own results.",
  "Changes on competing pages this shop cannot see.",
];

function scopeOf(change: SeoChange): { productId?: string; categoryId?: string } | null {
  if (change.entityType === "product") return { productId: change.entityId };
  if (change.entityType === "category") return { categoryId: change.entityId };
  return null;
}

/**
 * Compares the windows either side of one change. The change day itself is in
 * neither window: on the day of a change a page was both things.
 */
export async function compareAroundChange(
  executor: Executor,
  property: string,
  change: SeoChange,
  options: { windowDays?: number; latestMeasured?: string | null } = {},
): Promise<ChangeComparison> {
  const days = options.windowDays ?? 28;
  const scope = scopeOf(change);
  const base: ChangeComparison = {
    change,
    verdict: "not_measured",
    observation: "Search Console has no measurements for this page around that date.",
    causation: "not established",
    confounders: CONFOUNDERS,
    before: null,
    after: null,
    delta: null,
  };
  if (!scope) return base;

  const latest = options.latestMeasured ?? (await coverageFor(executor, property)).latest;
  if (!latest) return base;

  const changeDay = isoDay(change.changedAt);
  const beforeWindow: Window = { start: addDays(changeDay, -days), end: addDays(changeDay, -1) };
  const afterWindow: Window = { start: addDays(changeDay, 1), end: addDays(changeDay, days) };

  // The window after a change has to have happened before it can be measured,
  // and Search Console has to have reported it.
  const afterElapsed = daysBetween(afterWindow.end, latest) >= 0;
  const afterEnd = afterElapsed ? afterWindow.end : latest;
  const clippedAfter: Window = { start: afterWindow.start, end: afterEnd };
  if (daysBetween(clippedAfter.start, clippedAfter.end) < 0) {
    return {
      ...base,
      verdict: "window_incomplete",
      observation: `This change is too recent: Search Console has measurements up to ${latest}, and none after the change yet.`,
    };
  }

  const beforeDays = await daysWithData(executor, property, beforeWindow);
  const afterDays = await daysWithData(executor, property, clippedAfter);
  const before = await totalsFor(executor, property, beforeWindow, scope);
  const after = await totalsFor(executor, property, clippedAfter, scope);

  const enoughBefore = beforeDays >= windowLength(beforeWindow) * THRESHOLDS.MIN_WINDOW_COVERAGE;
  const enoughAfter = afterDays >= windowLength(clippedAfter) * THRESHOLDS.MIN_WINDOW_COVERAGE;
  const enoughTraffic = before.impressions + after.impressions >= MIN_IMPRESSIONS_TO_COMPARE;

  const withWindows = {
    ...base,
    before: { ...before, window: beforeWindow },
    after: { ...after, window: clippedAfter },
  };

  if (!enoughBefore || !enoughAfter) {
    return {
      ...withWindows,
      verdict: "insufficient_data",
      observation: `Not enough measured days to compare: ${beforeDays} of ${windowLength(beforeWindow)} before the change, ${afterDays} of ${windowLength(clippedAfter)} after it.`,
    };
  }
  if (!enoughTraffic) {
    return {
      ...withWindows,
      verdict: "insufficient_data",
      observation: `Too few impressions either side of the change (${before.impressions} before, ${after.impressions} after) for a difference to mean anything.`,
    };
  }

  const delta = {
    clicks: after.clicks - before.clicks,
    impressions: after.impressions - before.impressions,
    ctr: after.ctr - before.ctr,
    position: after.position != null && before.position != null ? after.position - before.position : null,
  };

  const direction = delta.clicks > 0 ? "increased" : delta.clicks < 0 ? "decreased" : "did not change";
  const observation =
    `${changeFieldLabel(change.field)} changed on ${changeDay}. ` +
    `Clicks ${direction} in the observed period after the change: ` +
    `${before.clicks.toLocaleString("en-GB")} in the ${windowLength(beforeWindow)} days before, ` +
    `${after.clicks.toLocaleString("en-GB")} in the ${windowLength(clippedAfter)} days after. ` +
    `Impressions went from ${before.impressions.toLocaleString("en-GB")} to ${after.impressions.toLocaleString("en-GB")}` +
    (before.position != null && after.position != null
      ? `, and average position from ${before.position.toFixed(1)} to ${after.position.toFixed(1)}.`
      : ".") +
    (afterElapsed ? "" : ` The window after the change is still filling: it covers ${windowLength(clippedAfter)} of ${days} days.`);

  return {
    ...withWindows,
    verdict: afterElapsed ? "observed" : "window_incomplete",
    observation,
    delta,
  };
}

/**
 * Recent SEO changes with what the measurements did around each. Read-only.
 */
export async function changeComparisons(
  actor: SessionUser | null,
  options: {
    productId?: string;
    categoryId?: string;
    windowDays?: number;
    limit?: number;
    executor?: Executor;
  } = {},
): Promise<{ property: string | null; comparisons: ChangeComparison[] }> {
  requirePermission(actor, "seo.view");
  const executor = options.executor ?? db;
  const changes =
    options.productId || options.categoryId
      ? await seoChangesFor(
          actor,
          { productId: options.productId, categoryId: options.categoryId },
          { limit: options.limit ?? 20, executor },
        )
      : await recentSeoChanges(actor, { limit: options.limit ?? 20, executor });

  const property = configuredProperty();
  if (!property) {
    return {
      property: null,
      comparisons: changes.map((change) => ({
        change,
        verdict: "not_measured" as const,
        observation: "Search Console is not connected, so nothing is measured either side of this change.",
        causation: "not established" as const,
        confounders: CONFOUNDERS,
        before: null,
        after: null,
        delta: null,
      })),
    };
  }

  const latest = (await coverageFor(executor, property)).latest;
  const comparisons: ChangeComparison[] = [];
  for (const change of changes) {
    comparisons.push(
      await compareAroundChange(executor, property, change, { windowDays: options.windowDays, latestMeasured: latest }),
    );
  }
  return { property, comparisons };
}
