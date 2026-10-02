"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import type { SeoFieldState } from "@/db/schema";
import type { ReadinessReport } from "@/lib/seo/readiness";

/**
 * What this listing measurably needs, and which fields are a person's own.
 *
 * There is no score: each line is a fact about a field on this listing, and a
 * failing line says what to change. Locking a field is how a merchandiser says
 * "this wording is mine" — SEO Pulse then refuses to touch it rather than
 * quietly working around it.
 */
export function SeoReadinessBox({
  productId,
  seo,
  search,
  fieldStates,
  previousAddresses,
}: {
  productId: string;
  seo: ReadinessReport;
  search: ReadinessReport;
  fieldStates: { field: string; label: string; state: SeoFieldState }[];
  previousAddresses: string[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPassed, setShowPassed] = useState(false);

  async function toggleLock(field: string, lock: boolean) {
    setPending(field);
    setError(null);
    const response = await fetch(`/api/admin/products/${productId}/seo/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field, lock }),
    });
    setPending(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }
    router.refresh();
  }

  // Keyed by report as well as id: the two reports share ids ("brand" is in both).
  const rows = [
    ...seo.checks.map((check) => ({ ...check, key: `seo:${check.id}` })),
    ...search.checks.map((check) => ({ ...check, key: `search:${check.id}` })),
  ];
  const failing = rows.filter((check) => check.state === "fail");
  const passing = rows.filter((check) => check.state === "pass");

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">Search readiness</h2>
        <p className="text-[0.75rem] text-ink/65">
          {seo.passed} of {seo.checks.length} search-engine checks pass · {search.passed} of {search.checks.length} for
          site search.
          {seo.blocking + search.blocking > 0 ? ` ${seo.blocking + search.blocking} needed check(s) failing.` : ""}
        </p>
      </div>

      {error ? <p role="alert" className="text-[0.75rem] text-stamp-red-text">{error}</p> : null}

      {failing.length === 0 ? (
        <p className="text-[0.75rem] text-ink/70">Every check passes.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {failing.map((check) => (
            <li key={check.key} className="flex flex-col gap-0.5 border-l-2 border-brass pl-2">
              <p className="text-[0.8rem] text-ink">
                {check.label} <span className="text-[0.7rem] text-ink/50">({check.severity})</span>
              </p>
              <p className="text-[0.7rem] text-ink/60">{check.detail}</p>
              {check.fix ? <p className="text-[0.7rem] text-ink/70">{check.fix}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {passing.length > 0 ? (
        <>
          <button
            type="button"
            className="self-start text-[0.7rem] text-blue-600 hover:underline"
            onClick={() => setShowPassed(!showPassed)}
          >
            {showPassed ? "Hide" : "Show"} the {passing.length} passing check(s)
          </button>
          {showPassed ? (
            <ul className="flex flex-col gap-1 text-[0.7rem] text-ink/60">
              {passing.map((check) => (
                <li key={check.key}>
                  {check.label} — {check.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <h3 className="text-[0.75rem] font-medium text-ink">Whose wording is whose</h3>
        <ul className="flex flex-col gap-1">
          {fieldStates.map((row) => (
            <li key={row.field} className="flex items-center justify-between gap-2 text-[0.75rem]">
              <span className="text-ink/75">
                {row.label} <span className="text-ink/50">· {row.state.toLowerCase()}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pending === row.field}
                onClick={() => void toggleLock(row.field, row.state !== "LOCKED")}
              >
                {row.state === "LOCKED" ? "Unlock" : "Lock"}
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {previousAddresses.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <h3 className="text-[0.75rem] font-medium text-ink">Old addresses still working</h3>
          <ul className="flex flex-col gap-0.5 text-[0.7rem] text-ink/60">
            {previousAddresses.map((slug) => (
              <li key={slug}>/products/{slug}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
