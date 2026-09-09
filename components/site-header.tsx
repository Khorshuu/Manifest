import Link from "next/link";
import { HeaderShell } from "@/components/header-shell";
import { IconCart, IconUser } from "@/components/icons";
import { SearchBox } from "@/components/search-box";
import {
  collectSubtreeIds,
  countPublicProductsByCategory,
  getCategoryTree,
} from "@/lib/catalog";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { countCartItems } from "@/lib/cart";
import { findCartId } from "@/lib/cart/session";

/**
 * The one place the brand blue is allowed to dominate — it anchors the
 * identity the way a shipping company's header does, without colouring the
 * rest of the page (docs/DESIGN_GUIDELINES.md).
 *
 * Everything here is fetched on the server; `HeaderShell` adds only the two
 * behaviours that need a browser.
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
   * The whole catalogue, two levels deep, with live counts.
   *
   * A top-level shelf holds nothing directly — the products are filed in its
   * children — so its number is rolled up from the whole subtree. A child's is
   * its own subtree for the same reason.
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

  return (
    <HeaderShell
      sections={sections}
      search={<SearchBox />}
      actions={
        <div className="flex shrink-0 items-center gap-1 text-meta sm:gap-3">
          {isStaff(user) ? (
            <Link
              href="/admin"
              className="hidden min-h-11 items-center rounded-control px-2 transition-colors hover:bg-[color:var(--head-ghost)] sm:inline-flex"
            >
              Admin
            </Link>
          ) : null}

          <Link
            href={user ? "/account" : "/login"}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 transition-colors hover:bg-[color:var(--head-ghost)]"
          >
            {/*
             * Icon *and* label, at every width. Dropping the word below `sm`
             * looked tidier and cost more than it bought: an icon-only
             * navigation item is the thing every set of guidelines warns
             * against, and it made the link's name the screen-reader sentence
             * rather than the word. The search moved to its own row, so there
             * is room for both.
             */}
            <IconUser size={18} className="shrink-0" />
            {user ? "Account" : "Sign in"}
          </Link>

          <Link
            href="/cart"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 transition-colors hover:bg-[color:var(--head-ghost)]"
          >
            <IconCart size={18} className="shrink-0" />
            Cart
            {cartCount > 0 ? (
              /* Keyed on the count so it stamps each time it changes —
                 the confirmation that an item really landed. */
              <span
                key={cartCount}
                className="animate-stamp inline-flex min-w-5 items-center justify-center rounded-card bg-brass px-1 font-medium tabular-nums text-ink"
              >
                {cartCount}
              </span>
            ) : null}
            <span className="sr-only">
              {cartCount === 1 ? "1 item in cart" : `${cartCount} items in cart`}
            </span>
          </Link>
        </div>
      }
    />
  );
}
