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
  refundableBdt,
  cancellationRequested,
}: {
  orderId: string;
  allowed: string[];
  canRefund: boolean;
  /** What is still refundable, worked out on the server from the payments. */
  refundableBdt: number;
  /** True while the shopper is waiting on an answer to a cancellation. */
  cancellationRequested: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReference, setRefundReference] = useState("");
  const [refunding, setRefunding] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");

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
    setRefundAmount("");
    setRefundReference("");
    setRefunding(false);
    setDecisionNote("");
    router.refresh();
  }

  const forward = allowed.filter((status) => status !== "refunded");

  return (
    <div className="flex flex-col gap-5">
      {cancellationRequested ? (
        <div className="border border-stamp-red bg-paper-raised p-4">
          <h3 className="font-display text-h3 text-ink">
            This shopper has asked to cancel
          </h3>
          <p className="mt-1 text-meta text-ink/70">
            Their reason is on the orders list. Approving cancels the order and
            returns any places it is still holding; declining leaves it exactly
            as it is. Neither pays any money back — a refund is recorded
            separately, once you have made it.
          </p>

          <div className="mt-3 flex flex-col gap-2">
            <label
              htmlFor="decisionNote"
              className="text-meta font-medium text-ink"
            >
              What did you agree with them?
            </label>
            <input
              id="decisionNote"
              value={decisionNote}
              onChange={(event) => setDecisionNote(event.target.value)}
              placeholder="Recorded in the order history"
              className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                send({
                  action: "resolve_cancellation",
                  decision: "approve",
                  note: decisionNote || undefined,
                })
              }
            >
              Approve and cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                send({
                  action: "resolve_cancellation",
                  decision: "decline",
                  note: decisionNote || undefined,
                })
              }
            >
              Decline, keep the order
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor="note" className="text-meta font-medium text-ink">
          Note for this status change
        </label>
        <input
          id="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Tracking number, courier, anything worth recording"
          className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
        />
        <p className="text-meta text-ink/70">
          Recorded against the status change in the order history. For a note
          that is not tied to a status change, use the shipping panel.
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
              Record a refund
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
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="refundAmount"
                  className="text-meta font-medium text-ink"
                >
                  Amount in taka (leave empty to refund all of it)
                </label>
                <input
                  id="refundAmount"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={refundAmount}
                  onChange={(event) => setRefundAmount(event.target.value)}
                  placeholder={`Up to ${refundableBdt / 100}`}
                  className="min-h-11 rounded-control border border-blue-300 px-3 text-body tabular-nums"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="refundReference"
                  className="text-meta font-medium text-ink"
                >
                  Reference of the transfer you made
                </label>
                <input
                  id="refundReference"
                  value={refundReference}
                  onChange={(event) => setRefundReference(event.target.value)}
                  placeholder="bKash or bank transaction id"
                  className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
                />
              </div>

              <p className="text-meta text-ink/70">
                This records a refund you have already paid by hand; it does not
                move any money itself. A part refund leaves the order running. A
                full one closes it and returns any places it still holds.
                Neither can be undone.
              </p>

              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  disabled={pending || refundReason.trim().length === 0}
                  onClick={() =>
                    send({
                      action: "refund",
                      reason: refundReason,
                      reference: refundReference.trim() || undefined,
                      amountBdt: refundAmount.trim()
                        ? Math.round(Number(refundAmount) * 100)
                        : undefined,
                    })
                  }
                >
                  {pending ? "Recording…" : "Record this refund"}
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
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>
    </div>
  );
}
