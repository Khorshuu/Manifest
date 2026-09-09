import Link from "next/link";
import { HeaderShell } from "@/components/header-shell";
import { SearchBox } from "@/components/search-box";
import { getCategoryTree } from "@/lib/catalog";
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
  const [tree, user, cartId] = await Promise.all([
    getCategoryTree(),
    getCurrentUser(),
    findCartId(),
  ]);
  const cartCount = cartId ? await countCartItems(cartId) : 0;
  const topLevel = tree.slice(0, 5).map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
  }));

  return (
    <HeaderShell
      categories={topLevel}
      search={<SearchBox />}
      actions={
        <div className="flex shrink-0 items-center gap-1 text-meta sm:gap-3">
          {isStaff(user) ? (
            <Link
              href="/admin"
              className="hidden min-h-11 items-center rounded-control px-2 underline-offset-4 hover:underline sm:inline-flex"
            >
              Admin
            </Link>
          ) : null}

          <Link
            href={user ? "/account" : "/login"}
            className="inline-flex min-h-11 items-center rounded-control px-2 underline-offset-4 hover:underline"
          >
            {user ? "Account" : "Sign in"}
          </Link>

          <Link
            href="/cart"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 underline-offset-4 hover:underline"
          >
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
