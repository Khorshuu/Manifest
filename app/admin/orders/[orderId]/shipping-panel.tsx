"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

/**
 * Booking a delivery and recording a tracking reference.
 *
 * Both paths exist deliberately: while there is no courier integration, staff
 * book deliveries themselves and paste the reference in. The booking button
 * exercises the same provider interface a real courier will sit behind.
 *
 * The page remounts this on a key derived from the tracking reference, so a
 * newly booked reference replaces whatever is in the field — resetting state
 * from a prop is what a key is for.
 */
export function ShippingPanel({
  orderId,
  trackingReference,
  internalNotes,
}: {
  orderId: string;
  trackingReference: string | null;
  internalNotes: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState(trackingReference ?? "");
  const [note, setNote] = useState("");

  async function send(body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/orders/${orderId}/shipping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "Something went wrong. Try again.");
      return;
    }

    setNote("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <label htmlFor="trackingReference" className="text-meta font-medium text-ink">
          Tracking reference
        </label>
        <input
          id="trackingReference"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          placeholder="Paste the courier's reference"
          className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
        />

        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={pending || reference.trim().length === 0}
            onClick={() =>
              send({ action: "set_tracking", trackingReference: reference })
            }
          >
            Save reference
          </Button>

          {!trackingReference ? (
            <Button
              type="button"
              variant="quiet"
              disabled={pending}
              onClick={() => send({ action: "book" })}
            >
              Book with the courier
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-blue-300 pt-5">
        <label htmlFor="internalNote" className="text-meta font-medium text-ink">
          Internal note
        </label>
        <textarea
          id="internalNote"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="rounded-control border border-blue-300 p-3 text-body"
        />
        <p className="text-meta text-ink/70">
          Staff only. Never shown to the customer.
        </p>
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || note.trim().length === 0}
            onClick={() => send({ action: "note", note })}
          >
            Add note
          </Button>
        </div>
      </div>

      {internalNotes ? (
        <pre className="whitespace-pre-wrap border-t border-blue-300 pt-4 text-meta text-ink/70">
          {internalNotes}
        </pre>
      ) : null}

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>
    </div>
  );
}
