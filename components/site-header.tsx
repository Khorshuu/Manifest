import Link from "next/link";
import { SearchBox } from "@/components/search-box";
import { getCategoryTree } from "@/lib/catalog";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { countCartItems } from "@/lib/cart";
import { findCartId } from "@/lib/cart/session";

/**
 * The one place the brand blue is allowed to dominate — it anchors the
 * identity the way a shipping company's header does, without colouring the
 * rest of the page (docs/DESIGN_GUIDELINES.md).
 */
export async function SiteHeader() {
  const [tree, user, cartId] = await Promise.all([
    getCategoryTree(),
    getCurrentUser(),
    findCartId(),
  ]);
  const cartCount = cartId ? await countCartItems(cartId) : 0;
  const topLevel = tree.slice(0, 5);

  return (
    <header className="bg-blue-600 text-paper">
      <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-8 gap-y-3 px-4 py-4 md:px-6">
        <Link href="/" className="font-display text-h3 tracking-tight">
          Manifest
        </Link>

        <nav aria-label="Categories" className="flex-1">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {topLevel.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/categories/${category.slug}`}
                  className="text-meta hover:underline"
                >
                  {category.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <SearchBox />

        <div className="flex items-center gap-4 text-meta">
          {isStaff(user) ? (
            <Link href="/admin" className="hover:underline">
              Admin
            </Link>
          ) : null}
          <Link href={user ? "/account" : "/login"} className="hover:underline">
            {user ? "Account" : "Sign in"}
          </Link>
          <Link href="/cart" className="hover:underline">
            Cart{cartCount > 0 ? ` (${cartCount})` : ""}
          </Link>
        </div>
      </div>
    </header>
  );
}
