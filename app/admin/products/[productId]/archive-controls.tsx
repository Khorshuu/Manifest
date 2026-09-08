"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

/**
 * Archive and restore, kept apart from the details form: archiving is a
 * lifecycle change, not a field, and its confirmation should not be lost when
 * the form remounts on the refreshed server data.
 */
export function ArchiveControls({
  productId,
  archived,
}: {
  productId: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function lifecycle(action: "archive" | "restore") {
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch(`/api/admin/products/${productId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });

    setPending(false);
    setConfirming(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage(
      action === "archive" ? "Product archived." : "Product restored as a draft.",
    );
    router.refresh();
  }

  return (
    <div>
      <p className="max-w-[70ch] text-meta text-ink/70">
        {archived
          ? "Restoring brings it back as a draft, so nothing goes back on sale before someone checks it."
          : "Archiving takes the product and its variants off sale. Nothing is deleted — past orders still reference it."}
      </p>

      <div className="mt-4">
        {archived ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => lifecycle("restore")}
          >
            Restore as a draft
          </Button>
        ) : confirming ? (
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              disabled={pending}
              onClick={() => lifecycle("archive")}
            >
              Yes, archive it
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Keep it on sale
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setConfirming(true)}
          >
            Archive this product
          </Button>
        )}
      </div>

      <div aria-live="polite" className="mt-3 flex flex-col gap-1">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
        {message ? <p className="text-meta text-transit-green-text">{message}</p> : null}
      </div>
    </div>
  );
}
