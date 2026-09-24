import Link from "next/link";
import { can } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { jobSummary } from "@/lib/jobs/runner";
import { knowledgeAttention } from "@/lib/pkb/intelligence";
import { preparationSummary } from "@/lib/preparation";
import { listUnresearchedProducts } from "@/lib/seo-pulse";
import { searchIndexStatus } from "@/lib/search/maintenance";
import { zeroResultQueries } from "@/lib/search/zero-results";
import { searchConsoleStatus, opportunityReport } from "@/lib/search-console";
import { seoHealth } from "@/lib/seo/health";
import { Metric, MetricGrid, Section, TabHeading } from "../ui";
import type { PreparationStage } from "@/db/schema";

/**
 * The Intelligence overview: what needs a person, and where to go about it.
 *
 * Every figure is a count returned by the system that owns the thing counted —
 * the preparation stage counts come from `lib/preparation`, the knowledge
 * counts from one aggregate over the knowledge tables, the SEO findings from
 * the deterministic audit, the search figures from recorded searches, the
 * Search Console figures from stored measurements. Nothing is invented to
 * fill a card, and a figure that cannot be derived is not shown: a role
 * without a permission simply does not get that section rather than getting a
 * dash where a number would be.
 *
 * Every count that has somewhere to go is a link to the tab that lists what it
 * counted, already filtered. That is the difference between this and a
 * dashboard.
 */

/** The preparation stages that mean work is still moving on its own. */
const ACTIVE_STAGES = [
  "IDENTIFYING",
  "FINDING_SOURCES",
  "RESEARCHING",
  "VERIFYING",
  "PREPARING_CONTENT",
  "PREPARING_SEARCH",
  "CHECKING_PAGE",
] as const satisfies readonly PreparationStage[];

/** The background jobs this workspace is responsible for (task section 16). */
const INTELLIGENCE_JOBS = new Set([
  "catalog.prepare_product",
  "pkb.enrich_product",
  "pkb.sync_listings",
  "seo.research_product",
  "seo.search_console_sync",
  "seo.search_console_schedule",
  "search.process_queue",
]);

const ZERO_RESULT_DAYS = 30;

export async function OverviewPanel({ user }: { user: SessionUser }) {
  const mayCatalogue = can(user, "catalog.manage");
  const maySearch = can(user, "search.manage");
  const maySeo = can(user, "seo.view");
  const mayJobs = can(user, "notifications.view");

  const [preparation, knowledge, unresearched, health, index, zeroResults, searchConsole, jobs] =
    await Promise.all([
      mayCatalogue ? preparationSummary(user) : Promise.resolve(null),
      mayCatalogue ? knowledgeAttention(user) : Promise.resolve(null),
      mayCatalogue ? listUnresearchedProducts(user, 1) : Promise.resolve(null),
      mayCatalogue ? seoHealth(user) : Promise.resolve(null),
      maySearch ? searchIndexStatus(user) : Promise.resolve(null),
      maySearch ? zeroResultQueries(user, ZERO_RESULT_DAYS) : Promise.resolve(null),
      maySeo ? searchConsoleStatus(user) : Promise.resolve(null),
      mayJobs ? jobSummary(user) : Promise.resolve(null),
    ]);

  // The opportunity report is only meaningful once measurements exist, and it
  // is the most expensive read on this screen — so it is not run at all when
  // nothing is connected (task section 25).
  const opportunities =
    searchConsole && searchConsole.state !== "not_configured" ? await opportunityReport(user) : null;

  const byStage = new Map((preparation ?? []).map((row) => [row.stage, Number(row.total)]));
  const stageCount = (stages: readonly PreparationStage[]) =>
    stages.reduce((total, stage) => total + (byStage.get(stage) ?? 0), 0);

  const failingBy = (severity: "required" | "recommended") =>
    (health?.issues ?? [])
      .filter((issue) => issue.severity === severity)
      .reduce((total, issue) => total + issue.count, 0);

  const deadIntelligenceJobs = (jobs?.counts ?? [])
    .filter((row) => row.status === "dead" && INTELLIGENCE_JOBS.has(row.kind))
    .reduce((total, row) => total + Number(row.total), 0);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <TabHeading title="What needs your attention">
        Counted from the systems themselves, not stored anywhere separately. Every figure with somewhere to go is a
        link to the list behind it.
      </TabHeading>

      {preparation ? (
        <Section
          id="preparation"
          title="Product preparation and SeoPulse"
          description="Research runs across the catalogue. A run is started from a product’s own screen; these are the ones that stopped."
          actions={
            <Link href="/admin/intelligence/seo-pulse" className="admin-chip">
              Open SeoPulse
            </Link>
          }
        >
          <MetricGrid>
            <Metric
              label="Being prepared"
              value={stageCount(ACTIVE_STAGES)}
              note="still working"
              href="/admin/intelligence/seo-pulse?filter=active"
            />
            <Metric
              label="Needs review"
              value={stageCount(["NEEDS_REVIEW"])}
              note="waiting for a decision"
              tone={stageCount(["NEEDS_REVIEW"]) > 0 ? "attention" : "plain"}
              href="/admin/intelligence/seo-pulse?filter=needs-review"
            />
            <Metric
              label="Blocked"
              value={stageCount(["BLOCKED"])}
              note="cannot continue yet"
              tone={stageCount(["BLOCKED"]) > 0 ? "attention" : "plain"}
              href="/admin/intelligence/seo-pulse?filter=blocked"
            />
            <Metric
              label="Failed"
              value={stageCount(["FAILED"])}
              note="a retry may fix it"
              tone={stageCount(["FAILED"]) > 0 ? "attention" : "plain"}
              href="/admin/intelligence/seo-pulse?filter=failed"
            />
          </MetricGrid>
          {unresearched && unresearched.total > 0 ? (
            <p className="text-[0.8125rem] text-ink/65">
              <Link href="/admin/intelligence/seo-pulse#unresearched" className="text-blue-600 hover:underline">
                {unresearched.total.toLocaleString("en-GB")} live product
                {unresearched.total === 1 ? " has" : "s have"} never been researched
              </Link>
              .
            </p>
          ) : null}
        </Section>
      ) : null}

      {knowledge ? (
        <Section
          id="knowledge"
          title="Product knowledge"
          description="Facts waiting to be accepted, disagreements to settle, and products nobody has identified yet."
          actions={
            <Link href="/admin/intelligence/knowledge" className="admin-chip">
              Open Product Knowledge
            </Link>
          }
        >
          <MetricGrid>
            <Metric
              label="Conflicts"
              value={knowledge.conflicts}
              note="values that disagree"
              tone={knowledge.conflicts > 0 ? "attention" : "plain"}
              href="/admin/intelligence/knowledge?focus=conflicts"
            />
            <Metric
              label="Proposed values"
              value={knowledge.openClaims}
              note="waiting to be accepted"
              href="/admin/intelligence/knowledge?focus=claims"
            />
            <Metric
              label="Not identified"
              value={knowledge.unresolvedIdentities}
              note="nobody has settled which product"
              tone={knowledge.unresolvedIdentities > 0 ? "attention" : "plain"}
              href="/admin/intelligence/knowledge?focus=unresolved"
            />
            <Metric
              label="More than one match"
              value={knowledge.ambiguousIdentities}
              note="several candidates still fit"
              href="/admin/intelligence/knowledge?focus=ambiguous"
            />
            <Metric
              label="New attributes proposed"
              value={knowledge.openProposals}
              note="the vocabulary does not have them"
              href="/admin/intelligence/knowledge?focus=proposals"
            />
            <Metric
              label="Unplaced labels"
              value={knowledge.unmappedValues}
              note="no attribute answers to them"
              href="/admin/intelligence/knowledge?focus=labels"
            />
            <Metric
              label="Sources suggested"
              value={knowledge.suggestedSources}
              note="waiting for approval"
              tone={knowledge.suggestedSources > 0 ? "attention" : "plain"}
              href="/admin/intelligence/sources#registry"
            />
            <Metric
              label="Brand relations suggested"
              value={knowledge.suggestedBrandRelations}
              note="waiting for approval"
              href="/admin/intelligence/sources#registry"
            />
          </MetricGrid>
        </Section>
      ) : null}

      {index && zeroResults ? (
        <Section
          id="searchpulse"
          title="SearchPulse"
          description={`This shop’s own search: what shoppers could not find in the last ${ZERO_RESULT_DAYS} days, and whether the index is keeping up.`}
          actions={
            <Link href="/admin/intelligence/searchpulse" className="admin-chip">
              Open SearchPulse
            </Link>
          }
        >
          <MetricGrid>
            <Metric
              label="Searches that found nothing"
              value={zeroResults.length}
              note={`distinct searches, last ${ZERO_RESULT_DAYS} days`}
              tone={zeroResults.length > 0 ? "attention" : "plain"}
              href="/admin/intelligence/searchpulse#zero-results"
            />
            <Metric
              label="Products not indexed"
              value={index.missing}
              note="cannot be found by search"
              tone={index.missing > 0 ? "attention" : "plain"}
              href="/admin/intelligence/searchpulse#index"
            />
            <Metric
              label="Waiting to be indexed"
              value={index.queued}
              note="queued for a retry"
              href="/admin/intelligence/searchpulse#index"
            />
            <Metric label="Products indexed" value={index.indexed} tone="positive" />
          </MetricGrid>
        </Section>
      ) : null}

      {health ? (
        <Section
          id="seo-health"
          title="SEO Health"
          description="Published listings failing a deterministic check. No score, because no figure this shop can compute predicts a ranking."
          actions={
            <Link href="/admin/intelligence/seo-health" className="admin-chip">
              Open SEO Health
            </Link>
          }
        >
          <MetricGrid>
            <Metric
              label="Needed"
              value={failingBy("required")}
              note="listings failing a required check"
              tone={failingBy("required") > 0 ? "attention" : "positive"}
              href="/admin/intelligence/seo-health?severity=required"
            />
            <Metric
              label="Worth doing"
              value={failingBy("recommended")}
              note="listings that could say more"
              href="/admin/intelligence/seo-health?severity=recommended"
            />
            <Metric label="Nothing to fix" value={health.clean} note="by these checks" tone="positive" />
            <Metric label="Indexable listings" value={health.indexableListings} note="not hidden from search" />
          </MetricGrid>
        </Section>
      ) : null}

      {searchConsole ? (
        <Section
          id="search-console"
          title="Search Console"
          description="What Google reports about these pages. Manifest works without it, and estimates nothing in its absence."
          actions={
            <Link href="/admin/intelligence/search-console" className="admin-chip">
              Open Search Console
            </Link>
          }
        >
          {searchConsole.state === "not_configured" ? (
            <div className="admin-card p-3.5">
              <p className="text-[0.8125rem] text-ink">Search Console is not connected.</p>
              <p className="mt-1 text-[0.8125rem] text-ink/65">
                Everything else in Intelligence works without it. Connecting it adds which searches show these pages,
                how often they are clicked and where they rank.{" "}
                <Link href="/admin/intelligence/search-console" className="text-blue-600 hover:underline">
                  How to connect it
                </Link>
                .
              </p>
            </div>
          ) : (
            <MetricGrid>
              <Metric
                label="Opportunities"
                value={opportunities?.opportunities.length ?? 0}
                note="findings from the measurements"
                href="/admin/intelligence/search-console"
              />
              <Metric
                label="Improving"
                value={opportunities?.improvements.length ?? 0}
                note="pages measurably better"
                tone="positive"
                href="/admin/intelligence/search-console"
              />
              <Metric
                label="Days with data"
                value={searchConsole.coverage?.daysWithData ?? 0}
                note="stored measurements"
              />
              <Metric
                label="Last successful sync"
                value={
                  searchConsole.lastSuccessAt
                    ? searchConsole.lastSuccessAt.toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })
                    : "Never"
                }
                note={searchConsole.state === "sync_failed" ? "the last attempt failed" : undefined}
                tone={searchConsole.state === "sync_failed" ? "attention" : "plain"}
                href="/admin/intelligence/search-console"
              />
            </MetricGrid>
          )}
        </Section>
      ) : null}

      {jobs && deadIntelligenceJobs > 0 ? (
        <Section
          id="jobs"
          title="Background work"
          description="Research, enrichment, indexing and Search Console syncs run as background jobs. The full job screen is a separate admin destination."
        >
          <div className="admin-card border-brass bg-brass/5 p-3.5 text-[0.8125rem]">
            <p className="text-ink">
              {deadIntelligenceJobs.toLocaleString("en-GB")} intelligence job
              {deadIntelligenceJobs === 1 ? " has" : "s have"} given up after their retries.
            </p>
            <p className="mt-1 text-ink/70">
              <Link href="/admin/jobs" className="text-blue-600 hover:underline">
                Open Background work
              </Link>{" "}
              to see what failed and why.
            </p>
          </div>
        </Section>
      ) : null}
    </div>
  );
}
