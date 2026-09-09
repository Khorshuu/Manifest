"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { formatBdt } from "@/lib/money";

/**
 * The money still owed on a deposit order, and the button that takes it.
 *
 * Staff decide when the balance is collected rather than it being charged
 * automatically when the goods land (DECISIONS.md D-012). So this states the
 * three figures a person needs before pressing anything — what the order comes
 * to, what has been paid, and what is left — rather than a single "collect"
 * button with the amount hidden behind it.
 *
 * The amount is not sent with the request. The server works out what is
 * outstanding from the order's own payment rows, so what is on this screen can
 * be stale without a wrong figure ever being charged.
 */
export function BalancePanel({
  orderId,
  totalBdt,
  paidBdt,
  outstandingBdt,
  collectable,
  reason,
}: {
  orderId: string;
  totalBdt: number;
  paidBdt: number;
  outstandingBdt: number;
  collectable: boolean;
  reason: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function take() {
    setPending(true);
    setError(null);
    setDone(null);

    try {
      const response = await fetch(`/api/orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "take_balance" }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.error ?? "That could not be taken. Try again.");
        return;
      }

      setDone(
        payload.result?.alreadyPaid
          ? "That balance had already been taken."
          : `Balance of ${formatBdt(payload.result.amountBdt)} received.`,
      );
      setConfirming(false);
      router.refresh();
    } catch {
      setError("That could not be taken. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2 text-meta">
        <div className="flex justify-between gap-4">
          <dt className="text-ink/70">Order total</dt>
          <dd className="tabular-nums text-ink">{formatBdt(totalBdt)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink/70">Paid so far</dt>
          <dd className="tabular-nums text-ink">{formatBdt(paidBdt)}</dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-blue-200 pt-2">
          <dt className="font-medium text-ink">Outstanding</dt>
          <dd
            className={`font-medium tabular-nums ${
              outstandingBdt > 0 ? "text-stamp-red-text" : "text-ink"
            }`}
          >
            {formatBdt(outstandingBdt)}
          </dd>
        </div>
      </dl>

      {collectable ? (
        confirming ? (
          <div className="flex flex-col gap-3">
            <p className="text-meta text-ink">
              Take {formatBdt(outstandingBdt)} from this customer now?
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={pending} onClick={() => void take()}>
                {pending ? "Taking…" : "Yes, take the balance"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Not yet
              </Button>
            </div>
          </div>
        ) : (
          /* A second click before money moves. Every other destructive or
             irreversible action on this screen asks the same way. */
          <Button type="button" onClick={() => setConfirming(true)}>
            Take balance payment
          </Button>
        )
      ) : (
        <p className="text-meta text-ink/70">
          {reason ?? "Nothing is outstanding on this order."}
        </p>
      )}

      <p aria-live="polite" className="text-meta">
        {error ? (
          <span className="text-stamp-red-text">{error}</span>
        ) : done ? (
          <span className="text-transit-green-text">{done}</span>
        ) : null}
      </p>
    </div>
  );
}
