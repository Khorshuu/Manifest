"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { formatShortDate } from "@/lib/format";
import type { LearningReport } from "@/lib/search-console/learning";
import type { SearchConsoleStatus } from "@/lib/search-console/metrics";
import type { Opportunity, OpportunityKind, OpportunityReport } from "@/lib/search-console/opportunities";
import { FormStatus } from "../products/[productId]/editor-parts";

/**
 * The Search Console connection, the opportunities it makes possible, and the
 * recommendations that need a person (D-096, D-097, D-100).
 *
 * With nothing connected this is a single sentence and an explanation. It is
 * deliberately not a screen full of zeroes: a zero is a measurement, and there
 * are no measurements.
 */

const KIND_LABELS: Record<OpportunityKind, { label: string; tone: string }> = {
  low_ctr: { label: "Shown, not clicked", tone: "bg-brass/20 text-ink" },
  content_gap: { label: "Words the page lacks", tone: "bg-blue-200/60 text-ink" },
  improvement_potential: { label: "Within reach", tone: "bg-blue-200/60 text-ink" },
  decline: { label: "Falling", tone: "bg-red-100 text-red-900" },
  improvement: { label: "Rising", tone: "bg-green-100 text-green-900" },
};

export function SearchConsolePanel({
  status,
  report,
  learning,
}: {
  status: SearchConsoleStatus;
  report: OpportunityReport | null;
  learning: LearningReport | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const response = await fetch("/api/admin/seo/search-console/sync", { method: "POST" });
    setBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "The sync could not be started.");
      return;
    }
    const body = await response.json();
    setMessage(
      body.alreadyQueued
        ? "That sync is already queued; it will report when it finishes."
        : `Syncing ${body.windowStart} to ${body.windowEnd}. It runs in the background.`,
    );
    router.refresh();
  }

  async function decide(opportunity: Opportunity, decision: "acted" | "dismissed" | "watching") {
    setPending(opportunity.key);
    setError(null);
    setMessage(null);
    const response = await fetch("/api/admin/seo/opportunities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        opportunityKey: opportunity.key,
        kind: opportunity.kind,
        entityType: opportunity.entityType,
        productId: opportunity.productId,
        categoryId: opportunity.categoryId,
        decision,
        evidence: opportunity.evidence,
      }),
    });
    setPending(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "That could not be recorded.");
      return;
    }
    setMessage("Recorded. The finding is still recomputed from the measurements; this is a note about what you decided.");
    router.refresh();
  }

  if (status.state === "not_configured") {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="font-display text-h3 text-ink">Search Console not connected</h2>
        <div className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
          <p className="text-body text-ink">{status.message}</p>
          <p className="mt-2 text-meta text-ink/70">
            Connecting it would add what Google actually reports: which searches show these pages, how often they are
            clicked, and where they rank. Everything else on this screen — the SEO checks, the change history, the
            knowledge base and the shop&rsquo;s own search — works without it, and nothing is estimated in its absence.
          </p>
        </div>
      </section>
    );
  }

  const coverage = status.coverage;

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-h3 text-ink">{status.property}</h2>
              <span
                className={`inline-flex items-center rounded-control px-2 py-1 text-meta font-medium ${
                  status.state === "connected"
                    ? "bg-green-100 text-green-900"
                    : status.state === "sync_failed"
                      ? "bg-red-100 text-red-900"
                      : "bg-brass/20 text-ink"
                }`}
              >
                {status.state === "connected" ? "Connected" : status.state === "sync_failed" ? "Last sync failed" : "Never synced"}
              </span>
            </div>
            <p className="text-meta text-ink/70">{status.message}</p>
            {status.account ? <p className="text-meta text-ink/55">Reading as {status.account}.</p> : null}
          </div>
          <Button type="button" onClick={sync} disabled={busy}>
            {busy ? "Starting…" : "Sync now"}
          </Button>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-meta md:grid-cols-4">
          <div>
            <dt className="text-ink/55">Last successful sync</dt>
            <dd className="text-ink tabular-nums">{status.lastSuccessAt ? formatShortDate(status.lastSuccessAt) : "never"}</dd>
          </div>
          <div>
            <dt className="text-ink/55">Measured up to</dt>
            <dd className="text-ink tabular-nums">{coverage?.latest ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-ink/55">Days stored</dt>
            <dd className="text-ink tabular-nums">{coverage?.daysWithData ?? 0}</dd>
          </div>
          <div>
            <dt className="text-ink/55">Measurements</dt>
            <dd className="text-ink tabular-nums">{(coverage?.rows ?? 0).toLocaleString("en-GB")}</dd>
          </div>
        </dl>

        {status.lastError ? <p className="mt-3 text-meta text-stamp-red-text">{status.lastError}</p> : null}
        {status.lastSync ? (
          <p className="mt-2 text-meta text-ink/55 tabular-nums">
            Last attempt {formatShortDate(status.lastSync.createdAt)}: {status.lastSync.status},{" "}
            {status.lastSync.rowsWritten.toLocaleString("en-GB")} rows written and{" "}
            {status.lastSync.rowsUnchanged.toLocaleString("en-GB")} already stored, over{" "}
            {status.lastSync.requestsMade} request{status.lastSync.requestsMade === 1 ? "" : "s"}.
          </p>
        ) : null}
      </div>

      <FormStatus error={error} message={message} />

      {report ? (
        <>
          {report.insufficient.length > 0 ? (
            <div className="rounded-card border border-blue-300 bg-paper p-4 text-meta shadow-[var(--shadow-raise)]">
              <p className="font-medium text-ink">Not enough data to judge</p>
              <ul className="mt-2 flex flex-col gap-1 text-ink/70">
                {report.insufficient.map((row) => (
                  <li key={`${row.subject}-${row.reason}`}>
                    <span className="text-ink">{row.subject}:</span> {row.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <OpportunityList
            title="Worth doing"
            body={
              report.window
                ? `From ${report.window.start} to ${report.window.end}, compared with this site's own pages at similar positions.`
                : ""
            }
            opportunities={report.opportunities}
            empty="Nothing in the measurements suggests work on a page right now."
            onDecide={decide}
            pending={pending}
          />

          <OpportunityList
            title="Doing better than before"
            body="Recorded so a page is not rewritten while it is improving."
            opportunities={report.improvements}
            empty="No page has measurably improved against the window before."
            onDecide={decide}
            pending={pending}
          />
        </>
      ) : null}

      {learning && learning.recommendations.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-h3 text-ink">Recommendations that need a person</h2>
            <ul className="text-meta text-ink/55">
              {learning.guardrails.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <ul className="flex flex-col gap-3">
            {learning.recommendations.slice(0, 25).map((row, index) => (
              <li
                key={`${row.kind}-${row.phraseKey ?? row.pagePath ?? index}`}
                className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
              >
                <p className="font-display text-h3 text-ink [overflow-wrap:anywhere]">{row.subject}</p>
                <p className="mt-2 text-body text-ink">{row.recommendation}</p>
                <p className="mt-1 text-meta text-ink/55">{row.requiresReview}</p>
                {row.productId ? (
                  <p className="mt-2 text-meta">
                    <Link href={`/admin/products/${row.productId}`} className="text-blue-600 hover:underline">
                      Open the listing
                    </Link>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function OpportunityList({
  title,
  body,
  opportunities,
  empty,
  onDecide,
  pending,
}: {
  title: string;
  body: string;
  opportunities: Opportunity[];
  empty: string;
  onDecide: (opportunity: Opportunity, decision: "acted" | "dismissed" | "watching") => void;
  pending: string | null;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-h3 text-ink">{title}</h2>
        {body ? <p className="max-w-2xl text-body text-ink/70">{body}</p> : null}
      </div>

      {opportunities.length === 0 ? (
        <EmptyState title="Nothing to show" body={empty} />
      ) : (
        <ul className="flex flex-col gap-3">
          {opportunities.map((row) => {
            const kind = KIND_LABELS[row.kind];
            return (
              <li key={row.key} className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-display text-h3 text-ink [overflow-wrap:anywhere]">
                    {row.productId ? (
                      <Link href={`/admin/products/${row.productId}`} className="text-blue-600 hover:underline">
                        {row.subject}
                      </Link>
                    ) : (
                      row.subject
                    )}
                  </p>
                  <span className={`inline-flex items-center rounded-control px-2 py-1 text-meta font-medium ${kind.tone}`}>
                    {kind.label}
                  </span>
                </div>
                {row.pagePath ? <p className="mt-1 text-meta text-ink/55 [overflow-wrap:anywhere]">{row.pagePath}</p> : null}

                <p className="mt-3 text-body text-ink">{row.observation}</p>
                <p className="mt-1 text-meta text-ink/70">{row.recommendation}</p>

                {row.decision ? (
                  <p className="mt-2 text-meta text-ink/55">
                    Recorded as “{row.decision.decision}” on {formatShortDate(row.decision.decidedAt)}.
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" disabled={pending === row.key} onClick={() => onDecide(row, "acted")}>
                      Acted on it
                    </Button>
                    <Button type="button" variant="secondary" disabled={pending === row.key} onClick={() => onDecide(row, "watching")}>
                      Watching
                    </Button>
                    <Button type="button" variant="secondary" disabled={pending === row.key} onClick={() => onDecide(row, "dismissed")}>
                      Not worth doing
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
