import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { IconRoute } from "@/components/icons";
import { PageHeading } from "@/components/page-heading";

export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false },
};

/**
 * A missing page, inside the shop rather than outside it.
 *
 * Without this file a bad product link dropped the visitor onto the framework's
 * own black-and-white 404 — no header, no search, no way back into the
 * catalogue, and nothing to say the shop still existed. This keeps the chrome
 * and offers the three routes someone who mistyped a link actually wants.
 */
export default function StorefrontNotFound() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-4 py-14 md:px-6 md:py-20">
      <PageHeading
        eyebrow="Nothing filed here"
        title="We could not find that page"
        summary="The link may be old, or the listing may have been withdrawn after its batch closed. Nothing is lost — everything open is one step away."
      />

      <EmptyState
        className="mt-8"
        icon={<IconRoute size={26} />}
        title="Try one of these"
        body="Search the catalogue, look at the windows that are open right now, or go back to the front of the shop."
        action={{ href: "/search?available=1", label: "See what is open" }}
        secondary={{ href: "/", label: "Back to the shop" }}
      />
    </div>
  );
}
