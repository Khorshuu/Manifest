import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { requireAdminPage } from "@/lib/auth/admin-page";
import {
  describeDataProvider,
  describeIntelligenceProvider,
  listRecentRuns,
  listUnresearchedProducts,
  PULSE_VERSION,
} from "@/lib/seo-pulse";

export const metadata: Metadata = { title: "SEO Pulse" };
export const dynamic = "force-dynamic";

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The catalogue-wide view of SEO Pulse: which providers are configured, the
 * recent research, and the products nobody has researched yet. Research
 * itself is run from each product's editor, so there is one place to do it.
 */
export default async function SeoPulseAdminPage() {
  const user = await requireAdminPage("catalog.manage");
  const [runs, unresearched] = await Promise.all([
    listRecentRuns(user, 30),
    listUnresearchedProducts(user, 20),
  ]);
  const ai = describeIntelligenceProvider();
  const data = describeDataProvider();

  const tableShell =
    "overflow-x-auto rounded-card border border-blue-300 bg-paper shadow-[var(--shadow-raise)]";
  const th = "px-4 py-3 text-left text-meta font-medium text-ink/70";
  const td = "border-t border-blue-300 px-4 py-3 text-meta text-ink";

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div>
        <h1 className="font-display text-h1 text-ink">SEO Pulse</h1>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          Product SEO and search research. Open a product and choose the SEO Pulse tab to run
          research, review the recommendations and apply the ones you want. Version {PULSE_VERSION}.
        </p>
      </div>

      <section aria-labelledby="providers-heading" className="flex flex-col gap-3">
        <h2 id="providers-heading" className="font-display text-h2 text-ink">
          Providers
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {[
            { title: "Analysis", provider: ai },
            { title: "External research", provider: data },
          ].map(({ title, provider }) => (
            <div
              key={title}
              className="flex flex-col gap-2 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-body font-semibold text-ink">{title}</h3>
                <StatusBadge tone={provider.configured ? "positive" : "neutral"}>
                  {provider.configured ? provider.label : "Unavailable"}
                </StatusBadge>
                {provider.paid ? <StatusBadge tone="warning">Paid per request</StatusBadge> : null}
              </div>
              <p className="text-meta text-ink/70">{provider.note}</p>
            </div>
          ))}
        </div>
        <p className="max-w-[70ch] text-meta text-ink/70">
          Providers are chosen with environment variables on the server (SEO_PULSE_AI_PROVIDER,
          SEO_PULSE_DATA_PROVIDER). Their keys are never sent to the browser.
        </p>
      </section>

      <section aria-labelledby="runs-heading" className="flex flex-col gap-3">
        <h2 id="runs-heading" className="font-display text-h2 text-ink">
          Recent research
        </h2>
        {runs.length === 0 ? (
          <EmptyState
            title="No research yet"
            body="Open any product and choose the SEO Pulse tab to run its first research."
          />
        ) : (
          <div className={tableShell}>
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className={th}>Product</th>
                  <th className={th}>Version</th>
                  <th className={th}>Completed</th>
                  <th className={th}>By</th>
                  <th className={th}>SEO score</th>
                  <th className={th}>Search score</th>
                  <th className={th}>Status</th>
                  <th className={th}>Download</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className={td}>
                      <Link
                        href={`/admin/products/${run.productId}`}
                        className="text-blue-600 underline-offset-4 hover:underline"
                      >
                        {run.productTitle}
                      </Link>
                    </td>
                    <td className={`${td} tabular-nums`}>{run.version}</td>
                    <td className={td}>{when(run.completedAt ?? run.createdAt)}</td>
                    <td className={td}>{run.initiatedBy ?? "—"}</td>
                    <td className={`${td} tabular-nums`}>{run.seoScore ?? "—"}</td>
                    <td className={`${td} tabular-nums`}>{run.searchScore ?? "—"}</td>
                    <td className={td}>
                      <StatusBadge
                        tone={
                          run.status === "failed"
                            ? "negative"
                            : run.appliedAt
                              ? "positive"
                              : "neutral"
                        }
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
                    <td className={td}>
                      {run.status === "completed" ? (
                        <span className="flex gap-3">
                          <a className="text-blue-600 underline-offset-4 hover:underline" href={`/api/admin/seo-pulse/runs/${run.id}/export?format=json`} download>
                            JSON
                          </a>
                          <a className="text-blue-600 underline-offset-4 hover:underline" href={`/api/admin/seo-pulse/runs/${run.id}/export?format=csv`} download>
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
          </div>
        )}
      </section>

      <section aria-labelledby="unresearched-heading" className="flex flex-col gap-3">
        <h2 id="unresearched-heading" className="font-display text-h2 text-ink">
          Not researched yet
        </h2>
        <p className="text-meta text-ink/70">
          {unresearched.total} product{unresearched.total === 1 ? "" : "s"} without any SEO Pulse research.
        </p>
        {unresearched.rows.length > 0 ? (
          <ul className="flex flex-col divide-y divide-blue-300 rounded-card border border-blue-300 bg-paper">
            {unresearched.rows.map((row) => (
              <li key={row.id} className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-4 py-2">
                <Link
                  href={`/admin/products/${row.id}`}
                  className="text-body text-blue-600 underline-offset-4 hover:underline"
                >
                  {row.title}
                </Link>
                <StatusBadge>{row.status}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
