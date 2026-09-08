"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

const LABELS: Record<string, string> = {
  payment_confirmed: "Mark payment confirmed",
  sourcing: "Mark as sourcing",
  shipped_from_us: "Mark shipped from the US",
  in_bd_customs: "Mark in customs",
  out_for_delivery: "Mark out for delivery",
  delivered: "Mark delivered",
  cancelled: "Cancel this order",
  refunded: "Refund this order",
};

export function OrderActions({
  orderId,
  allowed,
  canRefund,
}: {
  orderId: string;
  allowed: string[];
  canRefund: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refunding, setRefunding] = useState(false);

  async function send(body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/orders/${orderId}`, {
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
    setRefundReason("");
    setRefunding(false);
    router.refresh();
  }

  const forward = allowed.filter((status) => status !== "refunded");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label htmlFor="note" className="text-meta font-medium text-ink">
          Internal note
        </label>
        <input
          id="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Tracking number, courier, anything worth recording"
          className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
        />
        <p className="text-meta text-ink/70">
          Saved against the status change, and visible to staff only.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {forward.map((status) => (
          <Button
            key={status}
            type="button"
            variant={status === "cancelled" ? "secondary" : "primary"}
            disabled={pending}
            onClick={() =>
              send({ action: "advance", status, note: note || undefined })
            }
          >
            {LABELS[status] ?? status}
          </Button>
        ))}
      </div>

      {canRefund ? (
        <div className="border-t border-blue-300 pt-5">
          {!refunding ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRefunding(true)}
            >
              Refund this order
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              <label
                htmlFor="refundReason"
                className="text-meta font-medium text-ink"
              >
                Reason for the refund
              </label>
              <input
                id="refundReason"
                value={refundReason}
                onChange={(event) => setRefundReason(event.target.value)}
                required
                className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
              />
              <p className="text-meta text-ink/70">
                This returns the money through the payment provider and records
                a refund against the order. It cannot be undone.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  disabled={pending || refundReason.trim().length === 0}
                  onClick={() =>
                    send({ action: "refund", reason: refundReason })
                  }
                >
                  {pending ? "Refunding…" : "Confirm refund"}
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => setRefunding(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red">{error}</p> : null}
      </div>
    </div>
  );
}
