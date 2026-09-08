"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

/**
 * Sends whatever is queued now, rather than waiting for the next order event
 * to drain the outbox. Useful when a provider outage has left failures behind.
 */
export function DrainButton({ queued }: { queued: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function drain() {
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/admin/notifications", { method: "POST" });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    const body = await response.json();
    setMessage(
      `Attempted ${body.report.attempted}: ${body.report.sent} sent, ${body.report.failed} failed.`,
    );
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="secondary"
        disabled={pending || queued === 0}
        onClick={drain}
      >
        {pending ? "Sending…" : "Send queued messages"}
      </Button>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
        {message ? (
          <p className="text-meta text-transit-green-text">{message}</p>
        ) : null}
      </div>
    </div>
  );
}
