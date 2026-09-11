"use client";

import type { ReadinessCheck } from "@/lib/catalog";
import { FIX_TARGETS, openFix } from "./fix-targets";

/**
 * What publishing needs, at a glance: required items first, each with a way
 * straight to the field that fixes it. The same checks run on the server when
 * Publish now is pressed.
 */
export function ReadinessBox({ checks }: { checks: ReadinessCheck[] }) {
  const required = checks.filter((check) => check.required);
  const advisory = checks.filter((check) => !check.required && !check.passed);
  const missing = required.filter((check) => !check.passed).length;

  return (
    <section aria-labelledby="readiness-box" className="admin-card flex flex-col gap-2 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="readiness-box" className="admin-h2">Before publishing</h2>
        <span className={`text-[0.75rem] font-medium ${missing ? "text-stamp-red-text" : "text-transit-green-text"}`}>
          {missing ? `${missing} missing` : "Ready"}
        </span>
      </div>
      <ul className="flex flex-col gap-1 text-[0.75rem]">
        {[...required, ...advisory].map((check) => (
          <li key={check.id} className="flex items-start gap-1.5">
            <span aria-hidden="true" className={check.passed ? "text-transit-green-text" : check.required ? "text-stamp-red-text" : "text-brass-text"}>
              {check.passed ? "✓" : check.required ? "✕" : "!"}
            </span>
            <span className="min-w-0 flex-1 text-ink/85">
              {check.label}
              {check.required ? <span aria-hidden="true" className="text-stamp-red-text"> *</span> : null}
              <span className="sr-only">{check.passed ? " — done" : check.required ? " — required, missing" : " — recommended"}</span>
            </span>
            {!check.passed && FIX_TARGETS[check.id] ? (
              <button type="button" onClick={() => openFix(check.id)} className="shrink-0 font-semibold text-blue-600 hover:underline">
                Fix →
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
