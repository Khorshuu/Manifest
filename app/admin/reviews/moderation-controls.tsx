"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

/**
 * Approve or reject one review. Both decisions are audited server-side, so a
 * review that vanishes from a product page can always be explained.
 */
export function ModerationControls({
  reviewId,
  status,
}: {
  reviewId: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approved" | "rejected") {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/admin/reviews/${reviewId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending || status === "approved"}
          onClick={() => decide("approved")}
        >
          Approve
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || status === "rejected"}
          onClick={() => decide("rejected")}
        >
          Reject
        </Button>
      </div>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>
    </div>
  );
}
