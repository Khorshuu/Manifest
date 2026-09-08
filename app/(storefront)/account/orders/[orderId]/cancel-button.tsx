"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

export function CancelOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/orders/${orderId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    router.refresh();
  }

  // Cancelling cannot be undone, so it asks once before doing it.
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => setConfirming(true)}
      >
        Cancel this order
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-ink">
        Cancel this order? This cannot be undone.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={cancel} disabled={pending}>
          {pending ? "Cancelling…" : "Yes, cancel it"}
        </Button>
        <Button
          type="button"
          variant="quiet"
          onClick={() => setConfirming(false)}
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
