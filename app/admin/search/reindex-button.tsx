"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { FormStatus } from "../products/[productId]/editor-parts";

/**
 * Queues every index row for rebuilding. Idempotent, so pressing it twice is
 * harmless: the work happens in the background and the queue is keyed by
 * listing, so a second press queues nothing new (risk R-12).
 */
export function ReindexButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function rebuild() {
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/admin/search/reindex", { method: "POST" });
    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    const body = await response.json();
    setMessage(
      body.queued > 0
        ? `Queued ${body.queued} of ${body.products} listings. The index rebuilds in the background — the count below shows what is left.`
        : `Nothing to rebuild: all ${body.products} listings are indexed.`,
    );
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Button type="button" variant="secondary" disabled={pending} onClick={rebuild}>
        {pending ? "Queueing…" : "Rebuild search index"}
      </Button>
      <FormStatus error={error} message={message} />
    </div>
  );
}
