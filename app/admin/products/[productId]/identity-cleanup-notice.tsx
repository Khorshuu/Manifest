"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import type { IdentityCleanup } from "@/lib/catalog/identity-cleanup";

/**
 * Offers to take weak values out of the identity fields once the product's
 * version is established (D-123). Nothing changes until a person confirms; the
 * server checks every field again before clearing it.
 */
export function IdentityCleanupNotice({ productId, cleanup }: { productId: string; cleanup: IdentityCleanup }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reclassify() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/admin/products/${productId}/identity/reclassify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: cleanup.issues.map((issue) => issue.field) }),
    });
    const parsed = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(parsed.error ?? "Something went wrong. Try again.");
      return;
    }
    router.refresh();
  }

  return (
    <div
      role="status"
      data-identity-cleanup
      className="flex max-w-2xl flex-col gap-2 rounded-control border border-brass bg-brass/10 px-3 py-2 text-meta text-ink"
    >
      <p>
        <strong>These values are not the manufacturer&rsquo;s model.</strong> They read like the product&rsquo;s version,
        which is now established ({cleanup.established.map((fact) => `${fact.label}: ${fact.value}`).join("; ")}).
      </p>
      <ul className="list-disc pl-5">
        {cleanup.issues.map((issue) => (
          <li key={issue.field}>
            {issue.label}: &ldquo;{issue.value}&rdquo;
            {issue.equivalent ? ` — the same as ${issue.equivalent}` : " — not an identifier this product can be matched by"}
          </li>
        ))}
      </ul>
      <p className="text-ink/70">
        Reclassifying clears them from the identity fields. The established version stays, the change is recorded in the
        product&rsquo;s history, and the identity is checked again.
      </p>
      {error ? <p role="alert" className="text-stamp-red-text">{error}</p> : null}
      <div>
        <Button type="button" size="sm" disabled={pending} onClick={() => void reclassify()}>
          {pending ? "Reclassifying…" : "Reclassify these values"}
        </Button>
      </div>
    </div>
  );
}
