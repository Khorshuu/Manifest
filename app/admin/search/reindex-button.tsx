"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { FormStatus } from "../products/[productId]/editor-parts";

/** Rebuilds every index row. Idempotent, so pressing it twice is harmless. */
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
    setMessage(`Rebuilt the index for ${body.products} products.`);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Button type="button" variant="secondary" disabled={pending} onClick={rebuild}>
        {pending ? "Rebuilding…" : "Rebuild search index"}
      </Button>
      <FormStatus error={error} message={message} />
    </div>
  );
}
