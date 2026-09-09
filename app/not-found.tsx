import type { Metadata } from "next";
import Link from "next/link";
import { LinkButton } from "@/components/button";

export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false },
};

/**
 * The last-resort 404, for a URL that matches no route group at all — so it
 * gets the root layout only and carries its own header.
 *
 * The storefront has its own `not-found` with the full chrome; this one exists
 * so that even a wholly unrecognised path lands on something that looks like
 * this shop rather than on the framework's default.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col">
      <div className="bg-blue-600 text-paper">
        <div className="mx-auto flex w-full max-w-[1280px] items-baseline gap-2 px-4 py-3.5 font-display tracking-tight md:px-6">
          <Link href="/" className="text-h2">
            Manifest
          </Link>
          <span
            aria-hidden="true"
            className="text-meta uppercase tracking-[0.2em] text-paper/70"
          >
            BD
          </span>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center px-4 py-20 md:px-6">
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Nothing filed here
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">
          We could not find that page
        </h1>
        <p className="mt-3 max-w-[56ch] text-body text-ink/70">
          The address does not match anything in the shop. It may be an old
          link, or a listing withdrawn after its batch closed.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <LinkButton href="/" variant="primary">
            Back to the shop
          </LinkButton>
          <LinkButton href="/orders/lookup" variant="secondary">
            Track an order
          </LinkButton>
        </div>
      </div>
    </main>
  );
}
