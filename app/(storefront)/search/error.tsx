"use client";

import { useEffect } from "react";
import { Button, LinkButton } from "@/components/button";
import { IconAlert } from "@/components/icons";

/**
 * When a search fails outright — the database is unreachable, say. The header
 * and its search box stay put, so trying a different search is one step; this
 * offers the same search again, and a way to browse instead.
 */
export default function SearchError({
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
    <div className="mx-auto w-full max-w-[720px] px-4 py-16 md:px-6 md:py-20">
      <span
        aria-hidden="true"
        className="inline-flex size-12 items-center justify-center rounded-card border border-stamp-red bg-stamp-red/10 text-stamp-red-text"
      >
        <IconAlert size={26} />
      </span>

      <h1 className="mt-5 font-display text-h1 text-ink">
        The search did not finish
      </h1>
      <p className="mt-3 max-w-[56ch] text-body text-ink/70">
        Something went wrong on our side while looking that up. Try again — or
        browse the catalogue while we sort it out.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button type="button" onClick={reset}>
          Try the search again
        </Button>
        <LinkButton href="/search" variant="secondary">
          Browse everything
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
