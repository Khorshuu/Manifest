import type { Metadata } from "next";
import Link from "next/link";
import { getCartView } from "@/lib/cart";
import { findCartId } from "@/lib/cart/session";
import { CartLines } from "./cart-lines";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your cart",
  robots: { index: false },
};

export default async function CartPage() {
  const cartId = await findCartId();
  const cart = cartId ? await getCartView(cartId) : null;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <h1 className="font-display text-h1 text-ink">Your cart</h1>

      {!cart || cart.lines.length === 0 ? (
        /* An empty cart links somewhere, never to nowhere. */
        <div className="mt-8 border border-blue-300 p-8">
          <p className="text-body text-ink">Your cart is empty.</p>
          <p className="mt-2 max-w-[60ch] text-meta text-ink/70">
            Browse the open preorders and add something you cannot get locally.
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
          >
            Browse products
          </Link>
        </div>
      ) : (
        <div className="mt-8">
          <CartLines
            lines={cart.lines.map((line) => ({
              itemId: line.itemId,
              productTitle: line.productTitle,
              productSlug: line.productSlug,
              optionSummary: line.optionSummary,
              imageUrl: line.imageUrl,
              imageAlt: line.imageAlt,
              quantity: line.quantity,
              unitPriceBdt: line.unitPriceBdt,
              lineTotalBdt: line.lineTotalBdt,
              problem: line.problem,
            }))}
            subtotalBdt={cart.subtotalBdt}
            dueNowBdt={cart.dueNowBdt}
            hasProblems={cart.hasProblems}
          />
        </div>
      )}
    </div>
  );
}
