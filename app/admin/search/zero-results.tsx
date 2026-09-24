"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { formatShortDate } from "@/lib/format";
import type { ZeroResultFinding, ZeroResultVerdict } from "@/lib/search/zero-results";
import { FormStatus } from "../products/[productId]/editor-parts";

/**
 * Searches that found nothing, each with what is actually wrong (D-094).
 *
 * The verdict is what makes the list usable: a misspelling, a name the shop
 * does not answer to, a combination nothing has, something hidden that should
 * not be, a shelf with nothing on it, a product not stocked, or a search about
 * something else entirely. Four of those are not search faults at all, and
 * saying so is more useful than a list of words.
 *
 * "Record as an alias" creates a *suggestion*. It changes no search until it
 * is approved in the knowledge base.
 */

const VERDICTS: Record<ZeroResultVerdict, { label: string; tone: string }> = {
  typo: { label: "Misspelling", tone: "bg-blue-200/60 text-ink" },
  missing_alias: { label: "Another name for something", tone: "bg-brass/20 text-ink" },
  attribute_mismatch: { label: "Nothing has that combination", tone: "bg-brass/20 text-ink" },
  unavailable_product: { label: "Exists but hidden", tone: "bg-red-100 text-red-900" },
  missing_category: { label: "Empty shelf", tone: "bg-brass/20 text-ink" },
  missing_product: { label: "Not stocked", tone: "bg-blue-200/60 text-ink" },
  irrelevant: { label: "Unrelated", tone: "bg-blue-200/40 text-ink/70" },
};

export function ZeroResultIntelligence({
  findings,
  days,
  canSuggestAliases,
  basePath = "/admin/search",
}: {
  findings: ZeroResultFinding[];
  days: number;
  /** Whether this member of staff may record vocabulary at all. */
  canSuggestAliases: boolean;
  /**
   * Where "add a synonym instead" goes. The same list is rendered on the
   * standalone Search screen and on the Intelligence workspace's SearchPulse
   * tab, and a link back to the other one would lose the tab.
   */
  basePath?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function suggest(
    finding: ZeroResultFinding,
    candidate: ZeroResultFinding["aliasCandidates"][number],
  ) {
    const key = `${finding.query}:${candidate.target.id}`;
    setPending(key);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/admin/search/aliases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetKind: candidate.target.kind,
        targetId: candidate.target.id,
        alias: finding.query,
        aliasKind: finding.verdict === "typo" ? "misspelling" : "common_name",
        evidenceNote: `Searched ${finding.searches} times in the last ${days} days and found nothing.`,
      }),
    });
    setPending(null);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage(
      `“${finding.query}” is recorded as a suggested alias of ${candidate.target.name}. It changes nothing until it is approved.`,
    );
    router.refresh();
  }

  if (findings.length === 0) {
    return (
      <EmptyState
        title="Nothing unanswered"
        body={`Every search in the last ${days} days found something.`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FormStatus error={error} message={message} />
      <ul className="flex flex-col gap-3">
        {findings.map((finding) => {
          const verdict = VERDICTS[finding.verdict];
          return (
            <li
              key={finding.query}
              className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-display text-h3 text-ink [overflow-wrap:anywhere]">
                  {finding.query}
                </p>
                <span
                  className={`inline-flex items-center rounded-control px-2 py-1 text-meta font-medium ${verdict.tone}`}
                >
                  {verdict.label}
                </span>
              </div>

              <p className="mt-1 text-meta text-ink/70 tabular-nums">
                {finding.searches} {finding.searches === 1 ? "search" : "searches"} ·{" "}
                {finding.visitors} {finding.visitors === 1 ? "person" : "people"} · last{" "}
                {formatShortDate(finding.lastSearchedAt)}
              </p>

              <p className="mt-3 text-body text-ink">{finding.explanation}</p>
              <p className="mt-1 text-meta text-ink/70">{finding.recommendation}</p>

              {finding.correction ? (
                <p className="mt-2 text-meta">
                  <Link
                    href={`/search?q=${encodeURIComponent(finding.correction)}`}
                    className="text-blue-600 hover:underline"
                  >
                    See “{finding.correction}”
                  </Link>
                </p>
              ) : null}

              {finding.hiddenMatches.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1 text-meta">
                  {finding.hiddenMatches.map((match) => (
                    <li key={match.id}>
                      <Link
                        href={`/admin/products/${match.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {match.title}
                      </Link>{" "}
                      <span className="text-ink/70">— {match.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {finding.workingParts.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-2 text-meta">
                  {finding.workingParts.map((part) => (
                    <li key={part.query}>
                      <Link
                        href={`/search?q=${encodeURIComponent(part.query)}`}
                        className="inline-flex items-center rounded-control border border-blue-300 px-2 py-1 text-blue-600 hover:bg-blue-50"
                      >
                        {part.query} · {part.count}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}

              {canSuggestAliases && finding.aliasCandidates.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {finding.aliasCandidates.map((candidate) => (
                    <Button
                      key={candidate.target.id}
                      type="button"
                      variant="secondary"
                      disabled={pending === `${finding.query}:${candidate.target.id}`}
                      onClick={() => suggest(finding, candidate)}
                    >
                      {pending === `${finding.query}:${candidate.target.id}`
                        ? "Recording…"
                        : `Suggest as a name for ${candidate.target.name}`}
                    </Button>
                  ))}
                </div>
              ) : null}

              <p className="mt-3 text-meta">
                <Link
                  href={`${basePath}?days=${days}&term=${encodeURIComponent(finding.query)}#synonyms`}
                  className="font-semibold text-blue-600 hover:underline"
                >
                  Add a synonym instead
                </Link>
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
