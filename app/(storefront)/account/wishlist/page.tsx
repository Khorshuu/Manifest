import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountNav } from "@/components/account-nav";
import { EmptyState } from "@/components/empty-state";
import { IconStar } from "@/components/icons";
import { PageHeading } from "@/components/page-heading";
import { getCurrentUser } from "@/lib/auth";
import { listWishlist } from "@/lib/account";
import { WishlistList } from "./wishlist-list";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your wishlist",
  robots: { index: false },
};

export default async function WishlistPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/wishlist");

  const entries = await listWishlist(user.id);

  return (
    <div className="mx-auto w-full max-w-[960px] px-4 py-10 md:px-6 md:py-12">
      <PageHeading
        eyebrow="Your account"
        title="Your wishlist"
        summary={
          entries.length === 0
            ? "Things you want to come back to."
            : `${entries.length} saved item${entries.length === 1 ? "" : "s"}. Prices are today's, not the day you saved them.`
        }
      />
      <AccountNav current="/account/wishlist" />

      {entries.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon={<IconStar size={26} />}
          title="Nothing saved yet"
          body="Use “Save to wishlist” on a product, or “Save for later” in your cart, and it waits here — with its live price and whether it can still be bought."
          action={{ href: "/search?available=1", label: "See what is open" }}
        />
      ) : (
        <div className="mt-8">
          <WishlistList
            entries={entries.map((entry) => ({
              ...entry,
              savedAt: entry.savedAt.toISOString(),
            }))}
          />
        </div>
      )}
    </div>
  );
}
