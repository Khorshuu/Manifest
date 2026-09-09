"use client";

import { useEffect } from "react";
import { Button, LinkButton } from "@/components/button";
import { IconAlert } from "@/components/icons";

/**
 * When an admin page throws.
 *
 * Separate from the storefront boundary because the words are different: an
 * operator needs the reference to quote and needs to know that nothing was
 * written, whereas a customer needs reassurance about their money.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="max-w-[640px]">
      <span
        aria-hidden="true"
        className="inline-flex size-12 items-center justify-center rounded-card border border-stamp-red bg-stamp-red/10 text-stamp-red-text"
      >
        <IconAlert size={26} />
      </span>

      <h1 className="mt-5 font-display text-h1 text-ink">
        This screen failed to load
      </h1>
      <p className="mt-3 text-body text-ink/70">
        The request did not complete. Nothing was written — a page that only
        reads cannot have changed anything, and any action you were part-way
        through was not applied.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
        <LinkButton href="/admin" variant="secondary">
          Back to the overview
        </LinkButton>
      </div>

      {error.digest ? (
        <p className="mt-8 text-meta text-ink/70">
          Reference <span className="tabular-nums">{error.digest}</span>
        </p>
      ) : null}
    </div>
  );
}
