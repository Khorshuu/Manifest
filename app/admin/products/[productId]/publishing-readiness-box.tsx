"use client";

import { useState } from "react";
import type { ReadinessCheck } from "@/lib/catalog";
import type { ListingAudit } from "@/lib/seo/audit";
import { FIX_TARGETS, openFix } from "./fix-targets";

/**
 * Before publishing: one list, from the engines that already exist (D-116).
 *
 * There is no new readiness engine here. The required and recommended lines
 * are `getReadiness`'s own checks, and the recommendations under them are
 * `listingAudit`'s own findings — the same two sources the action bar and the
 * page-audit panel used separately, put in one place because a staff member
 * asking "can I publish this yet?" was previously answered by three panels
 * that did not agree about which of them was the answer.
 *
 * The detail stays available and stays secondary: the audit's full reasoning,
 * including which other listing shares this one's wording, opens on request.
 */
export function PublishingReadinessBox({
  checks,
  audit,
}: {
  checks: ReadinessCheck[];
  audit: ListingAudit;
}) {
  const [showDetail, setShowDetail] = useState(false);

  const required = checks.filter((check) => check.required);
  const advisory = checks.filter((check) => !check.required && !check.passed);
  const missing = required.filter((check) => !check.passed).length;
  const recommendations = audit.findings.filter((finding) => finding.severity !== "required").length;
  const blocking = audit.findings.filter((finding) => finding.severity === "required");

  return (
    <section aria-labelledby="publishing-readiness" className="admin-card flex flex-col gap-2 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="publishing-readiness" className="admin-h2">
          Before publishing
        </h2>
        <span
          className={`text-[0.75rem] font-medium ${
            missing ? "text-stamp-red-text" : "text-transit-green-text"
          }`}
        >
          {missing ? `${missing} missing` : "Ready"}
        </span>
      </div>

      <ul className="flex flex-col gap-1 text-[0.75rem]">
        {[...required, ...advisory].map((check) => (
          <li key={check.id} className="flex items-start gap-1.5">
            <span
              aria-hidden="true"
              className={
                check.passed
                  ? "text-transit-green-text"
                  : check.required
                    ? "text-stamp-red-text"
                    : "text-brass-text"
              }
            >
              {check.passed ? "✓" : check.required ? "✕" : "!"}
            </span>
            <span className="min-w-0 flex-1 text-ink/85">
              {check.label}
              {check.required ? (
                <span aria-hidden="true" className="text-stamp-red-text">
                  {" "}
                  *
                </span>
              ) : null}
              <span className="sr-only">
                {check.passed ? " — done" : check.required ? " — required, missing" : " — recommended"}
              </span>
            </span>
            {!check.passed && FIX_TARGETS[check.id] ? (
              <button
                type="button"
                onClick={() => openFix(check.id)}
                className="shrink-0 font-semibold text-blue-600 hover:underline"
              >
                Fix →
              </button>
            ) : null}
          </li>
        ))}

        {blocking.map((finding) => (
          <li key={finding.id} className="flex items-start gap-1.5">
            <span aria-hidden="true" className="text-stamp-red-text">
              ✕
            </span>
            <span className="min-w-0 flex-1 text-ink/85">{finding.label}</span>
          </li>
        ))}

        {recommendations > 0 ? (
          <li className="flex items-start gap-1.5">
            <span aria-hidden="true" className="text-brass-text">
              !
            </span>
            <span className="min-w-0 flex-1 text-ink/85">
              {recommendations} search {recommendations === 1 ? "recommendation" : "recommendations"}
            </span>
          </li>
        ) : null}
      </ul>

      {audit.findings.length > 0 || audit.duplication.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={showDetail}
            onClick={() => setShowDetail((current) => !current)}
            className="self-start text-[0.75rem] font-medium text-blue-600 hover:underline"
          >
            {showDetail ? "Hide details" : "View details"}
          </button>

          {showDetail ? (
            <div className="flex flex-col gap-2 border-t border-blue-200 pt-2">
              {audit.technical ? (
                <p className="text-[0.75rem] text-ink/65">
                  {audit.technical.indexable ? "Search engines may list this page" : "Search engines are told to skip this page"}{" "}
                  — {audit.technical.indexableReason}.
                </p>
              ) : null}
              {audit.findings.map((finding) => (
                <div key={finding.id} className="flex flex-col gap-0.5">
                  <p className="text-[0.8rem] font-medium text-ink">{finding.label}</p>
                  <p className="text-[0.75rem] text-ink/65">{finding.detail}</p>
                  <p className="text-[0.75rem] text-ink/55">{finding.fix}</p>
                </div>
              ))}
              {audit.duplication.length > 0 ? (
                <p className="text-[0.75rem] text-ink/65">
                  Some wording is shared with another listing. Two pages competing on the same words make each other
                  harder to find.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
