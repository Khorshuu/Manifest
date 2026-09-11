"use client";

import { Button } from "@/components/button";

/** Shown when the product list cannot be loaded — never a blank page. */
export default function ProductsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="admin-card flex max-w-xl flex-col items-start gap-3">
      <h1 className="admin-h1">Unable to load products</h1>
      <p className="text-meta text-ink/75">
        The product list could not be read just now. Nothing has been changed. Try again, and if it
        keeps happening, check that the database is running.
      </p>
      <Button type="button" onClick={() => reset()}>
        Retry
      </Button>
    </div>
  );
}
