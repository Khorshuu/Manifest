"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import type { FieldRecommendation, SeoPulseRecommendations } from "@/lib/seo-pulse";

/**
 * SeoPulse's latest wording, shown in the section the field belongs to
 * (D-120), so staff never have to open a report to see what was prepared.
 *
 * What it offers depends on who owns what the field holds now:
 *
 *  - empty — "Use SeoPulse version".
 *  - SeoPulse's own, unedited — "Regenerate with SeoPulse": the old wording
 *    was never anyone's, so a click is enough.
 *  - written or edited by staff — "Keep current", "Review SeoPulse version",
 *    and "Replace with SeoPulse version" only once the version has been
 *    opened, behind a confirmation.
 *  - locked — the version can be read, never applied from here.
 *
 * Nothing here writes on its own. Every write is a click, the server re-checks
 * ownership under the listing lock, and the change history records it.
 */
export function SeoPulseRecommendationsPanel({
  productId,
  recommendations,
  fields,
}: {
  productId: string;
  recommendations: SeoPulseRecommendations | null;
  /** The fields this section owns. */
  fields: readonly FieldRecommendation["field"][];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [kept, setKept] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  if (!recommendations) return null;
  const shown = recommendations.fields.filter((entry) => fields.includes(entry.field) && !kept[entry.field]);
  if (shown.length === 0) return null;

  /** Unsaved edits are saved first, so ownership is judged on what is on screen. */
  async function saveFirst(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
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
  }

  async function write(entry: FieldRecommendation, replaceStaff: boolean) {
    if (
      replaceStaff &&
      !window.confirm(`Replace the current ${entry.label.toLowerCase()} with the SeoPulse version? The current wording stays in the change history.`)
    ) {
      return;
    }
    setError(null);
    setBusy(entry.field);
    if (!(await saveFirst())) {
      setBusy(null);
      setError("Some changes could not be saved. Fix them, then try again.");
      return;
    }
    const response = await fetch(`/api/admin/products/${productId}/seo-pulse/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: recommendations!.runId, fields: [entry.field], replaceStaff }),
    }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    setBusy(null);
    if (!response?.ok) {
      setError(body.error ?? "SeoPulse could not update this field. Try again.");
      router.refresh();
      return;
    }
    router.refresh();
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    const response = await fetch(`/api/admin/products/${productId}/seo-pulse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Fresh: staff asked for new wording, so recent research is not reused.
      body: JSON.stringify({ requestKey: crypto.randomUUID(), fresh: true }),
    }).catch(() => null);
    setRefreshing(false);
    if (!response?.ok) {
      const body = response ? await response.json().catch(() => ({})) : {};
      setError(body.error ?? "SeoPulse could not prepare new recommendations.");
      return;
    }
    router.refresh();
  }

  return (
    <section
      aria-label="SeoPulse recommendations"
      data-testid="seo-pulse-recommendations"
      className="flex flex-col gap-3 rounded-control border border-blue-300 bg-blue-50/50 p-3.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[0.875rem] font-semibold text-ink">SeoPulse recommendations</h3>
        <span className="text-[0.75rem] text-ink/65">
          Prepared {new Date(recommendations.preparedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-[0.75rem] text-ink/65">
        {recommendations.stale ? <span className="text-brass-text">The product changed after these were prepared.</span> : null}
        <Button type="button" size="sm" variant="quiet" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Preparing…" : "Refresh recommendations"}
        </Button>
      </p>

      {shown.map((entry) => (
        <div key={entry.field} data-field={entry.field} data-owner={entry.owner} className="flex flex-col gap-2 border-t border-blue-200 pt-2.5 first-of-type:border-t-0 first-of-type:pt-0">
          <p className="text-[0.8125rem] text-ink">
            <span className="font-semibold">{entry.label}.</span> {ownerNote(entry)}
          </p>
          <div className="flex flex-wrap gap-2">
            {entry.owner === "empty" ? (
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void write(entry, false)}>
                {busy === entry.field ? "Writing…" : "Use SeoPulse version"}
              </Button>
            ) : null}
            {entry.owner === "seo_pulse" ? (
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void write(entry, false)}>
                {busy === entry.field ? "Regenerating…" : "Regenerate with SeoPulse"}
              </Button>
            ) : null}
            {entry.owner === "staff" ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => setKept((state) => ({ ...state, [entry.field]: true }))}>
                Keep current
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="quiet"
              aria-expanded={Boolean(open[entry.field])}
              onClick={() => setOpen((state) => ({ ...state, [entry.field]: !state[entry.field] }))}
            >
              {open[entry.field] ? "Hide SeoPulse version" : "Review SeoPulse version"}
            </Button>
            {entry.owner === "staff" && open[entry.field] ? (
              <Button type="button" size="sm" variant="danger" disabled={busy !== null} onClick={() => void write(entry, true)}>
                {busy === entry.field ? "Replacing…" : "Replace with SeoPulse version"}
              </Button>
            ) : null}
          </div>
          {open[entry.field] ? <Proposed entry={entry} /> : null}
        </div>
      ))}

      {error ? (
        <p role="alert" className="text-[0.75rem] text-stamp-red-text">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ownerNote(entry: FieldRecommendation): string {
  switch (entry.owner) {
    case "empty":
      return "Empty. SeoPulse has prepared one from the verified product information.";
    case "seo_pulse":
      return "The current version was written by SeoPulse and nobody has edited it since. A newer version is ready.";
    case "staff":
      return "Written or edited by staff. SeoPulse will not replace it unless you choose to.";
    case "locked":
      return "Locked. SeoPulse will not change it. Unlock it in SEO readiness to use the new version.";
  }
}

function Proposed({ entry }: { entry: FieldRecommendation }) {
  const box = "rounded-control border border-blue-200 bg-white p-3 text-[0.8125rem] text-ink";
  if (Array.isArray(entry.proposed)) {
    return (
      <ul data-testid="seo-pulse-proposed" className={`${box} list-disc pl-7`}>
        {entry.proposed.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    );
  }
  if (entry.field === "descriptionHtml") {
    // Sanitised on the server with the same rule the product page renders by.
    return <div data-testid="seo-pulse-proposed" className={`${box} product-copy`} dangerouslySetInnerHTML={{ __html: entry.proposed }} />;
  }
  return (
    <p data-testid="seo-pulse-proposed" className={box}>
      {entry.proposed}
    </p>
  );
}
