"use client";

import { useEffect } from "react";
import { Button, LinkButton } from "@/components/button";
import { IconAlert } from "@/components/icons";

/**
 * When a storefront page throws.
 *
 * The framework's default is a blank screen with a stack trace in development
 * and nothing at all in production. This keeps the header and footer, says
 * plainly what happened, and offers the two things that actually help: try the
 * page again, or go somewhere that works.
 *
 * The digest is shown because it is the only thing a customer can quote to us
 * about a failure they cannot describe. It identifies the error, not them.
 */
export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server logging already has this; the browser console is where a
    // developer looking at the page will expect to find it.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-16 md:px-6 md:py-24">
      <span
        aria-hidden="true"
        className="inline-flex size-12 items-center justify-center rounded-card border border-stamp-red bg-stamp-red/10 text-stamp-red-text"
      >
        <IconAlert size={26} />
      </span>

      <h1 className="mt-5 font-display text-h1 text-ink">
        Something went wrong on our side
      </h1>
      <p className="mt-3 max-w-[56ch] text-body text-ink/70">
        Nothing you did caused this and nothing has been charged. Try the page
        again — if it keeps happening, your cart and any orders are untouched.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
        <LinkButton href="/" variant="secondary">
          Back to the shop
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
