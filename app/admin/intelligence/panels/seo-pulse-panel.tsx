import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import type { PreparationStage } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  listPreparationRuns,
  preparationSummary,
  STAGE_LABEL,
  type PreparationRunRow,
} from "@/lib/preparation";
import {
  describeDataProvider,
  describeIntelligenceProvider,
  listRecentRuns,
  listUnresearchedProducts,
  PULSE_VERSION,
} from "@/lib/seo-pulse";
import {
  PREPARATION_WAITING,
  SEO_PULSE_FILTER_LABEL as FILTER_LABEL,
  SEO_PULSE_FILTERS,
  type SeoPulseFilter,
} from "../filters";
import { Metric, MetricGrid, Section, TabHeading, TableShell } from "../ui";
import { ResearchSetup } from "@/components/research-setup";

/**
 * The SeoPulse tab: product research and preparation across the catalogue.
 *
 * Preparation is started from a product's own screen, where the person adding
 * the product is. This is the manager's view of the same runs — what has been
 * researched, what stopped and why, and what has never been looked at. It
 * starts nothing and changes nothing itself.
 *
 * Neither the preparation orchestration nor SeoPulse is reimplemented here:
 * every figure and every row comes from `lib/preparation` and `lib/seo-pulse`
 * exactly as the product editor reads them.
 */

const STAGE_TONE: Record<PreparationStage, "negative" | "warning" | "positive" | "neutral"> = {
  IDENTIFYING: "neutral",
  FINDING_SOURCES: "neutral",
  RESEARCHING: "neutral",
  VERIFYING: "neutral",
  NEEDS_REVIEW: "warning",
  PREPARING_CONTENT: "neutral",
  PREPARING_SEARCH: "neutral",
  CHECKING_PAGE: "neutral",
  READY: "positive",
  FAILED: "negative",
  BLOCKED: "warning",
  CANCELLED: "neutral",
};

function when(value: Date | string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PreparationTable({ rows }: { rows: PreparationRunRow[] }) {
  return (
    <TableShell>
      <table className="admin-table min-w-[44rem]">
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Where it got to</th>
            <th scope="col">What it says</th>
            <th scope="col">Started by</th>
            <th scope="col">Last moved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link href={`/admin/products/${row.productId}`} className="text-blue-600 hover:underline">
                  {row.productTitle}
                </Link>
              </td>
              <td>
                <StatusBadge tone={STAGE_TONE[row.stage]}>{STAGE_LABEL[row.stage]}</StatusBadge>
              </td>
              <td className="max-w-[28rem] text-ink/70">{row.headline ?? "—"}</td>
              <td className="text-ink/70">{row.requestedBy ?? "—"}</td>
              <td className="whitespace-nowrap tabular-nums text-ink/70">{when(row.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

export async function SeoPulsePanel({
  user,
  filter,
}: {
  user: SessionUser;
  filter?: SeoPulseFilter;
}) {
  const [stages, preparations, recent, unresearched] = await Promise.all([
    preparationSummary(user),
    listPreparationRuns(user, { stages: filter ? SEO_PULSE_FILTERS[filter] : PREPARATION_WAITING, limit: 40 }),
    listRecentRuns(user, 20),
    listUnresearchedProducts(user, 10),
  ]);

  const byStage = new Map(stages.map((row) => [row.stage, Number(row.total)]));
  const countOf = (keys: readonly PreparationStage[]) =>
    keys.reduce((total, stage) => total + (byStage.get(stage) ?? 0), 0);

  const needsReview = countOf(SEO_PULSE_FILTERS["needs-review"]);
  const blocked = countOf(SEO_PULSE_FILTERS.blocked);
  const failed = countOf(SEO_PULSE_FILTERS.failed);

  const ai = describeIntelligenceProvider();
  const data = describeDataProvider();

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <TabHeading title="SeoPulse">
        Product research and preparation. A run is started from a product&rsquo;s own screen; this is where every
        run across the catalogue can be seen, including the ones that stopped and what they are waiting for.
      </TabHeading>

      <MetricGrid>
        <Metric
          label="In progress"
          value={countOf(SEO_PULSE_FILTERS.active)}
          note="still working"
          href="/admin/intelligence/seo-pulse?filter=active"
        />
        <Metric
          label="Needs review"
          value={needsReview}
          note="waiting for a decision"
          tone={needsReview > 0 ? "attention" : "plain"}
          href="/admin/intelligence/seo-pulse?filter=needs-review"
        />
        <Metric
          label="Blocked"
          value={blocked}
          note="cannot continue yet"
          tone={blocked > 0 ? "attention" : "plain"}
          href="/admin/intelligence/seo-pulse?filter=blocked"
        />
        <Metric
          label="Failed"
          value={failed}
          note="a retry may fix it"
          tone={failed > 0 ? "attention" : "plain"}
          href="/admin/intelligence/seo-pulse?filter=failed"
        />
      </MetricGrid>

      <Section
        id="setup"
        title="Research setup"
        description="The optional services product preparation can use. Preparation works with all of them off; each one only widens what it can find or read."
      >
        <ResearchSetup />
      </Section>

      {!ai.configured || !data.configured ? (
        <p className="admin-card border-brass bg-brass/5 p-3.5 text-[0.8125rem] text-ink/80">
          {!ai.configured && !data.configured
            ? "Neither the analysis provider nor external research is configured. SeoPulse still prepares content from what the knowledge base already holds, and says so on each run."
            : !ai.configured
              ? "No analysis provider is configured. SeoPulse works from the knowledge base and the built-in rules."
              : "External research is not configured. SeoPulse works from the sources already recorded against each product."}
        </p>
      ) : null}

      <Section
        id="preparation"
        title={filter ? `Preparation — ${FILTER_LABEL[filter]}` : "Preparation runs waiting on a person"}
        description={
          filter ? (
            <>
              Showing {FILTER_LABEL[filter].toLowerCase()} runs.{" "}
              <Link href="/admin/intelligence/seo-pulse" className="text-blue-600 hover:underline">
                Show everything waiting
              </Link>
              .
            </>
          ) : (
            "Runs that stopped: a decision to make, something missing, or something that went wrong. Open the product to act on one."
          )
        }
      >
        {preparations.length === 0 ? (
          <EmptyState
            title={filter ? `No ${FILTER_LABEL[filter].toLowerCase()} runs` : "Nothing is waiting"}
            body={
              filter === "failed"
                ? "No failed product preparation runs."
                : "No product preparation run needs a decision right now."
            }
          />
        ) : (
          <PreparationTable rows={preparations} />
        )}
      </Section>

      <Section
        id="recent"
        title="Recent research"
        description={`The last SeoPulse runs across the catalogue, with their reports. Version ${PULSE_VERSION}.`}
      >
        {recent.length === 0 ? (
          <EmptyState
            title="No research yet"
            body="Open any product and run SeoPulse to produce its first research report."
          />
        ) : (
          <TableShell>
            <table className="admin-table min-w-[48rem]">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Finished</th>
                  <th scope="col">By</th>
                  <th scope="col">Search-engine checks</th>
                  <th scope="col">Site-search checks</th>
                  <th scope="col">Status</th>
                  <th scope="col">Report</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link href={`/admin/products/${run.productId}`} className="text-blue-600 hover:underline">
                        {run.productTitle}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap tabular-nums text-ink/70">
                      {when(run.completedAt ?? run.createdAt)}
                    </td>
                    <td className="text-ink/70">{run.initiatedBy ?? "—"}</td>
                    <td className="tabular-nums">
                      {run.seoChecks
                        ? `${run.seoChecks.passed}/${run.seoChecks.total}`
                        : run.seoScore !== null
                          ? `${run.seoScore}/100 (old score)`
                          : "—"}
                    </td>
                    <td className="tabular-nums">
                      {run.searchChecks
                        ? `${run.searchChecks.passed}/${run.searchChecks.total}`
                        : run.searchScore !== null
                          ? `${run.searchScore}/100 (old score)`
                          : "—"}
                    </td>
                    <td>
                      <StatusBadge
                        tone={run.status === "failed" ? "negative" : run.appliedAt ? "positive" : "neutral"}
                      >
                        {run.status === "failed"
                          ? "Failed"
                          : run.status === "running"
                            ? "Running"
                            : run.appliedAt
                              ? "Applied"
                              : "Not applied"}
                      </StatusBadge>
                    </td>
                    <td>
                      {run.status === "completed" ? (
                        <span className="flex gap-3 whitespace-nowrap">
                          <a
                            className="text-blue-600 hover:underline"
                            href={`/api/admin/seo-pulse/runs/${run.id}/export?format=json`}
                            download
                          >
                            JSON
                          </a>
                          <a
                            className="text-blue-600 hover:underline"
                            href={`/api/admin/seo-pulse/runs/${run.id}/export?format=csv`}
                            download
                          >
                            CSV
                          </a>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Section>

      <Section
        id="unresearched"
        title="Never researched"
        description={`${unresearched.total.toLocaleString("en-GB")} live product${
          unresearched.total === 1 ? " has" : "s have"
        } never had a SeoPulse run.`}
      >
        {unresearched.rows.length === 0 ? (
          <EmptyState
            title="Every product has been researched"
            body="No live listing is without a SeoPulse run."
          />
        ) : (
          <ul className="admin-card flex flex-col divide-y divide-blue-200 p-0">
            {unresearched.rows.map((row) => (
              <li
                key={row.id}
                className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-3.5 py-2"
              >
                <Link href={`/admin/products/${row.id}`} className="text-[0.8125rem] text-blue-600 hover:underline">
                  {row.title}
                </Link>
                <StatusBadge>{row.status}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <details className="admin-card p-3.5 text-[0.8125rem]">
        <summary className="cursor-pointer font-medium text-ink/80">Providers and versions</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[
            { title: "Analysis", provider: ai },
            { title: "External research", provider: data },
          ].map(({ title, provider }) => (
            <div key={title} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{title}</span>
                <StatusBadge tone={provider.configured ? "positive" : "neutral"}>
                  {provider.configured ? provider.label : "Not configured"}
                </StatusBadge>
                {provider.paid ? <StatusBadge tone="warning">Paid per request</StatusBadge> : null}
              </div>
              <p className="text-ink/65">{provider.note}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-ink/65">
          Providers are chosen with environment variables on the server (SEO_PULSE_AI_PROVIDER,
          SEO_PULSE_DATA_PROVIDER). Their keys are never sent to the browser. SeoPulse version {PULSE_VERSION}.
        </p>
      </details>
    </div>
  );
}
