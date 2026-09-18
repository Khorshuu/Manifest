import { db } from "@/db";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { Executor } from "@/lib/pkb/common";
import { seoChangesFor, type SeoChange } from "@/lib/seo/history";
import { addDays } from "./config";
import { compareAroundChange, type ChangeComparison } from "./comparison";
import { configuredProperty, coverageFor, queryPerformance, totalsFor, type QueryPerformance, type Totals, type Window } from "./metrics";

/**
 * One listing's search performance, for the product editor.
 *
 * Deliberately lighter than the catalogue-wide report: three scoped queries
 * over indexed rows, and no benchmark pass over every page. The opportunity
 * engine's comparisons against the rest of the site need the whole catalogue,
 * so they stay on the Search performance screen, which this box links to.
 */

export type ListingPerformance = {
  connected: boolean;
  /** Null when Search Console is not connected, or has nothing stored yet. */
  window: Window | null;
  totals: Totals | null;
  topQueries: QueryPerformance[];
  changes: SeoChange[];
  comparisons: ChangeComparison[];
};

export async function listingSearchPerformance(
  actor: SessionUser | null,
  productId: string,
  options: { windowDays?: number; executor?: Executor; changeLimit?: number } = {},
): Promise<ListingPerformance> {
  requirePermission(actor, "catalog.manage");
  const executor = options.executor ?? db;
  const changes = await seoChangesFor(actor, { productId }, { limit: options.changeLimit ?? 5, executor });

  const property = configuredProperty();
  if (!property) return { connected: false, window: null, totals: null, topQueries: [], changes, comparisons: [] };

  const coverage = await coverageFor(executor, property);
  if (!coverage.latest) {
    return { connected: true, window: null, totals: null, topQueries: [], changes, comparisons: [] };
  }

  const days = options.windowDays ?? 28;
  const window: Window = { start: addDays(coverage.latest, -(days - 1)), end: coverage.latest };
  const totals = await totalsFor(executor, property, window, { productId });
  const topQueries = await queryPerformance(executor, property, window, { productId, limit: 8 });

  const comparisons: ChangeComparison[] = [];
  for (const change of changes) {
    comparisons.push(await compareAroundChange(executor, property, change, { windowDays: days, latestMeasured: coverage.latest }));
  }

  return { connected: true, window, totals, topQueries, changes, comparisons };
}
