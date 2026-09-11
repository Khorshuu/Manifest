"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { ArchiveControls } from "../archive-controls";
import { PublishingSection } from "./publishing-section";

const LIVE_STATUSES = [
  { value: "preorder_open", label: "Preorder open — customers can order now" },
  { value: "in_stock", label: "In stock — ships from stock on hand" },
  { value: "coming_soon", label: "Coming soon — visible, not yet orderable" },
  { value: "preorder_closed", label: "Preorder closed — the window has ended" },
  { value: "discontinued", label: "Discontinued — visible, no longer sold" },
] as const;

/**
 * Visibility: whether customers can see the product, how it is offered while
 * live, when it should go up or come down, and archiving. Changing how a live
 * product is offered goes through the publish check, like publishing itself.
 */
export function VisibilitySection({
  productId,
  status,
  live,
  archived,
  publishAt,
  unpublishAt,
}: {
  productId: string;
  status: string;
  live: boolean;
  archived: boolean;
  publishAt: string;
  unpublishAt: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(live ? status : "preorder_open");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function change() {
    setPending(true);
    setError(null);
    setMessage(null);
    const response = await fetch(`/api/admin/products/${productId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: value }),
    }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    setPending(false);
    if (!response?.ok) {
      const detail = Array.isArray(body.failures)
        ? ` ${body.failures.map((failure: { label: string }) => failure.label).join("; ")}.`
        : "";
      setError(`${body.error ?? "That did not work."}${detail}`);
      return;
    }
    setMessage("Updated. Customers see the new state now.");
    router.refresh();
  }

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <section className="flex flex-col gap-3 rounded-card border border-blue-300 bg-paper p-4">
        <h3 className="text-body font-semibold text-ink">Customers can see it</h3>
        {archived ? (
          <p className="text-meta text-ink/75">No — it is archived. Restore it below to work on it again.</p>
        ) : live ? (
          <>
            <p className="text-meta text-ink/75">Yes. Choose how it is offered while it is live.</p>
            <label className="flex flex-col gap-1 text-meta font-medium text-ink" htmlFor="live-status">
              Offered as
              <select
                id="live-status"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
              >
                {LIVE_STATUSES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <Button type="button" variant="secondary" size="sm" disabled={pending || value === status} onClick={() => void change()}>
                {pending ? "Updating…" : "Update"}
              </Button>
            </div>
            <p className="text-meta text-ink/65">To hide it again, use ⋮ → Unpublish in the bar at the top.</p>
          </>
        ) : (
          <p className="text-meta text-ink/75">
            No — it is a {status === "scheduled" ? "scheduled draft" : "draft"}. Press{" "}
            <strong>Publish now</strong> in the bar at the top when it is ready; anything still missing
            will be listed there.
          </p>
        )}
        <div aria-live="polite">
          {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
          {message ? <p className="text-meta text-transit-green-text">{message}</p> : null}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-body font-semibold text-ink">Schedule</h3>
        <PublishingSection productId={productId} status={status} publishAt={publishAt} unpublishAt={unpublishAt} />
      </section>

      <section className="flex flex-col gap-3 border-t border-blue-300 pt-6">
        <h3 className="text-body font-semibold text-ink">{archived ? "Restore" : "Archive"}</h3>
        <ArchiveControls productId={productId} archived={archived} />
      </section>
    </div>
  );
}
