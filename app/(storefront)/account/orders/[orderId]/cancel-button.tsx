"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

/**
 * Asking to cancel an order.
 *
 * It is a request, not a cancellation: staff read it, speak to the customer,
 * and make the final decision (DECISIONS.md D-014). So the wording promises a
 * conversation rather than an outcome — a button that said "Cancel this order"
 * and then did not cancel it would be worse than no button.
 *
 * The reason is optional and goes to staff in the customer's own words. It is
 * the thing that most often makes the decision obvious.
 */
export function CancelOrderButton({
  orderId,
  requestedAt,
}: {
  orderId: string;
  /** Set when a request is already open, so the panel shows that instead. */
  requestedAt: string | null;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", reason: reason.trim() }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "Something went wrong. Try again.");
        return;
      }

      setAsking(false);
      router.refresh();
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  if (requestedAt) {
    return (
      <div className="rounded-card border border-brass/60 bg-paper-raised p-4 shadow-[var(--shadow-raise)]">
        <p className="text-body text-ink">
          You asked us to cancel this order on{" "}
          {new Date(requestedAt).toLocaleDateString()}.
        </p>
        <p className="mt-1 text-meta text-ink/70">
          We are looking at it and will be in touch. The order carries on until
          we have both agreed to stop it, so nothing is lost while we talk.
        </p>
      </div>
    );
  }

  if (!asking) {
    return (
      <Button type="button" variant="secondary" onClick={() => setAsking(true)}>
        Ask us to cancel
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-ink">
        Tell us why, and we will come back to you.
      </p>

      <div className="flex flex-col gap-1">
        <label
          htmlFor={`cancel-reason-${orderId}`}
          className="text-meta font-medium text-ink"
        >
          Reason (optional)
        </label>
        <textarea
          id={`cancel-reason-${orderId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          rows={3}
          className="rounded-control border border-blue-300 px-3 py-2 text-body text-ink"
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={() => void request()} disabled={pending}>
          {pending ? "Sending…" : "Send the request"}
        </Button>
        <Button
          type="button"
          variant="quiet"
          onClick={() => setAsking(false)}
          disabled={pending}
        >
          Keep my order
        </Button>
      </div>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>
    </div>
  );
}
