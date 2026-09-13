"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import type { FillResult } from "@/lib/seo-pulse";

/**
 * SEO Pulse, as the product editor shows it: a small box with one button.
 *
 * "Fill with SEO Pulse" saves anything unsaved, researches the product (or
 * reuses research on an unchanged product), and writes into every empty field
 * what it can say reliably — SEO title, meta description, focus keyword,
 * search terms, tags, and a factual starter description. What the admin
 * already wrote is never replaced. Facts it cannot know are listed for the
 * admin to add. The detailed analysis is only in the downloadable report.
 */
export function SeoPulseBox({
  productId,
  lastRunId,
  lastRunAt,
  stale,
  paid,
}: {
  productId: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  stale: boolean;
  paid: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "saving" | "analyzing" | "done" | "error">("idle");
  const [result, setResult] = useState<FillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runId = result?.runId ?? lastRunId;

  async function fill() {
    if (paid && !window.confirm("SEO Pulse will use the paid research/AI providers configured on the server. Continue?")) return;
    setError(null);
    setState("saving");
    // Save unsaved edits first, so SEO Pulse works from what is on screen.
    const saved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 25_000);
      window.dispatchEvent(
        new CustomEvent("product-editor:save-request", {
          detail: (ok: boolean) => {
            clearTimeout(timer);
            resolve(ok);
          },
        }),
      );
    });
    if (!saved) {
      setState("error");
      setError("Some changes could not be saved. Fix them, then try again.");
      return;
    }
    setState("analyzing");
    const response = await fetch(`/api/admin/products/${productId}/seo-pulse/fill`, { method: "POST" }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) {
      setState("error");
      setError(body.error ?? "Unable to generate — review the product information and try again.");
      return;
    }
    setResult(body as FillResult);
    setState("done");
    router.refresh();
  }

  const status =
    state === "saving"
      ? "Saving your changes…"
      : state === "analyzing"
        ? "Analyzing…"
        : state === "done"
          ? "Optimization complete"
          : state === "error"
            ? "Unable to generate"
            : lastRunAt
              ? stale
                ? "Product changed — run again"
                : `✓ Optimized ${new Date(lastRunAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
              : "Ready";

  return (
    <section aria-labelledby="seo-pulse-box" className="admin-card flex flex-col gap-3 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="seo-pulse-box" className="admin-h2">SEO Pulse</h2>
        <span
          aria-live="polite"
          className={`text-[0.75rem] font-medium ${
            state === "error" ? "text-stamp-red-text" : state === "done" || (lastRunAt && !stale && state === "idle") ? "text-transit-green-text" : "text-ink/65"
          }`}
        >
          {status}
        </span>
      </div>
      <p className="text-[0.75rem] text-ink/65">
        Fills empty description, specification, measurement, SEO and search fields from the facts you entered. Your own text is kept, and nothing is invented.
      </p>
      <Button type="button" size="sm" disabled={state === "saving" || state === "analyzing"} onClick={() => void fill()}>
        {state === "saving" || state === "analyzing" ? "Working…" : "✨ Fill with SEO Pulse"}
      </Button>

      {error ? <p role="alert" className="text-[0.75rem] text-stamp-red-text">{error}</p> : null}

      {result ? (
        <div className="flex flex-col gap-1.5 border-t border-blue-200 pt-2 text-[0.75rem]">
          <p className="text-ink">
            {result.filled.length > 0 ? (
              <>
                <span className="font-semibold">Filled:</span> {result.filled.join(", ")}.
              </>
            ) : (
              "Nothing was empty — no field changed."
            )}
          </p>
          {result.kept.length > 0 ? (
            <p className="text-ink/65">Kept yours: {result.kept.join(", ")}.</p>
          ) : null}
          {result.needsInput.length > 0 ? (
            <p className="text-brass-text">
              <span className="font-semibold">Needs your input:</span> {result.needsInput.join(", ")}.
            </p>
          ) : null}
          {result.imagesNeedReview > 0 ? (
            <p className="text-ink/65">Photo descriptions are yours to write — SEO Pulse cannot see photographs.</p>
          ) : null}
        </div>
      ) : null}

      {runId ? (
        <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-blue-200 pt-2 text-[0.75rem]">
          <span className="text-ink/70">Report:</span>
          <a className="text-blue-600 hover:underline" href={`/api/admin/seo-pulse/runs/${runId}/export?format=html`} target="_blank" rel="noopener">
            View
          </a>
          <a className="text-blue-600 hover:underline" href={`/api/admin/seo-pulse/runs/${runId}/export?format=json`} download>
            JSON
          </a>
          <a className="text-blue-600 hover:underline" href={`/api/admin/seo-pulse/runs/${runId}/export?format=csv`} download>
            CSV
          </a>
        </p>
      ) : null}
    </section>
  );
}
