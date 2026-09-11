import Link from "next/link";
import { Suspense } from "react";
import { AccountMenu } from "@/components/account-menu";
import { HeaderShell } from "@/components/header-shell";
import { IconCart, IconHeart, IconUser } from "@/components/icons";
import { SearchBox, SearchBoxFallback } from "@/components/search-box";
import {
  collectSubtreeIds,
  countPublicProductsByCategory,
  getCategoryTree,
} from "@/lib/catalog";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { countCartItems } from "@/lib/cart";
import { findCartId } from "@/lib/cart/session";

/**
 * The storefront header. Everything here is fetched on the server;
 * `HeaderShell` adds only the behaviours that need a browser.
 *
 * Signed in, the account link greets the shopper by first name — only the
 * first name, never the email address, which would put a private identifier
 * on every screen someone might share. An account with no name on record
 * reads "Account".
 */
export async function SiteHeader() {
  const [tree, counts, user, cartId] = await Promise.all([
    getCategoryTree(),
    countPublicProductsByCategory(),
    getCurrentUser(),
    findCartId(),
  ]);
  const cartCount = cartId ? await countCartItems(cartId) : 0;

  /*
   * The whole catalogue, two levels deep, with live counts. A top-level shelf
   * holds nothing directly, so its number is rolled up from its subtree.
   */
  const rollUp = (category: (typeof tree)[number]) =>
    collectSubtreeIds(category).reduce(
      (total, id) => total + (counts.get(id) ?? 0),
      0,
    );

  const sections = tree.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    productCount: rollUp(category),
    children: category.children.map((child) => ({
      id: child.id,
      name: child.name,
      slug: child.slug,
      productCount: rollUp(child),
    })),
  }));

  const firstName = user?.firstName?.trim().split(/\s+/)[0]?.slice(0, 20) || null;
  const accountLabel = user ? (firstName ?? "Account") : "Sign in";

  // The wishlist is account-only (D-031): a guest goes through sign-in and is
  // brought straight back to it.
  const wishlistHref = user ? "/account/wishlist" : "/login?next=/account/wishlist";

  const item =
    "inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 font-semibold transition-colors hover:bg-[color:var(--head-ghost)]";

  return (
    <HeaderShell
      sections={sections}
      search={
        /*
         * Keyed on the session so signing in or out swaps whose recent
         * searches it holds.
         */
        <Suspense fallback={<SearchBoxFallback />}>
          <SearchBox key={user ? "signed-in" : "guest"} signedIn={Boolean(user)} />
        </Suspense>
      }
      actions={
        <div className="flex shrink-0 items-center gap-0.5 text-meta sm:gap-1.5">
          {isStaff(user) ? (
            <Link href="/admin" className={`hidden sm:inline-flex ${item}`}>
              Admin
            </Link>
          ) : null}

          {user ? (
            <AccountMenu label={accountLabel} isStaff={isStaff(user)} />
          ) : (
            <Link href="/login" className={item}>
              <IconUser size={18} className="shrink-0" />
              <span className="max-w-[9ch] truncate sm:max-w-[12ch]">{accountLabel}</span>
            </Link>
          )}

          <Link href={wishlistHref} className={item}>
            <IconHeart size={18} className="shrink-0" />
            <span className="sr-only sm:not-sr-only">Wishlist</span>
          </Link>

          <Link href="/cart" className={item}>
            <IconCart size={18} className="shrink-0" />
            <span className="sr-only sm:not-sr-only">Cart</span>
            {cartCount > 0 ? (
              /* Keyed on the count so it stamps each time it changes —
                 the confirmation that an item really landed. */
              <span
                key={cartCount}
                aria-hidden="true"
                className="animate-stamp inline-flex min-w-5 items-center justify-center rounded-card bg-brass px-1 font-bold tabular-nums text-ink"
              >
                {cartCount}
              </span>
            ) : null}
            <span className="sr-only">
              {cartCount === 1 ? ", 1 item" : `, ${cartCount} items`}
            </span>
          </Link>
        </div>
      }
    />
  );
}
