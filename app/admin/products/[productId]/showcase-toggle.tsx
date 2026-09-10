"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

/**
 * Put this product on the homepage, from the page staff are already on.
 *
 * The row can also be arranged at `/admin/homepage`, but the moment someone
 * decides a product should be on the front page is usually the moment they are
 * looking at the product — so the decision is available there too, and both
 * write the same setting through the same permission check.
 */
export function ShowcaseToggle({
  slug,
  isFeatured,
  isPublic,
}: {
  slug: string;
  isFeatured: boolean;
  /** A draft cannot be on the homepage; the storefront would not show it. */
  isPublic: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setPending(true);
    setError(null);

    const response = await fetch("/api/admin/homepage/showcase", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: isFeatured ? "remove" : "add",
        slug,
      }),
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
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant={isFeatured ? "danger" : "secondary"}
        disabled={pending || (!isPublic && !isFeatured)}
        onClick={toggle}
      >
        {pending
          ? "Saving…"
          : isFeatured
            ? "Remove from the homepage"
            : "Add to the homepage"}
      </Button>

      <span aria-live="polite" className="text-meta">
        {error ? (
          <span className="text-stamp-red-text">{error}</span>
        ) : isFeatured ? (
          <span className="text-transit-green-text">
            On the homepage row now.
          </span>
        ) : !isPublic ? (
          <span className="text-ink/70">
            Publish this listing first — the homepage only shows public
            products.
          </span>
        ) : null}
      </span>
    </div>
  );
}
