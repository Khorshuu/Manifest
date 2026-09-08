import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { addresses } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getCartView } from "@/lib/cart";
import { findCartId } from "@/lib/cart/session";
import { codAllowed } from "@/lib/orders";
import { CheckoutForm } from "./checkout-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false },
};

export default async function CheckoutPage() {
  const cartId = await findCartId();
  const cart = cartId ? await getCartView(cartId) : null;

  if (!cart || cart.lines.length === 0) redirect("/cart");

  const user = await getCurrentUser();

  const saved = user
    ? await db
        .select()
        .from(addresses)
        .where(eq(addresses.userId, user.id))
    : [];

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <p className="text-meta text-blue-600">
        <Link href="/cart" className="hover:underline">
          Cart
        </Link>
      </p>
      <h1 className="mt-2 font-display text-h1 text-ink">Checkout</h1>

      {cart.hasProblems ? (
        <div className="mt-6 border border-stamp-red p-5">
          <p className="text-body text-ink">
            Some items in your cart changed. Review them before continuing.
          </p>
          <Link
            href="/cart"
            className="mt-3 inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
          >
            Back to cart
          </Link>
        </div>
      ) : (
        <div className="mt-8">
          <CheckoutForm
            summary={{
              subtotalBdt: cart.subtotalBdt,
              dueNowBdt: cart.dueNowBdt,
              lineCount: cart.lines.length,
              codAllowed: codAllowed(cart.lines),
            }}
            savedAddresses={saved.map((address) => ({
              id: address.id,
              label: `${address.recipientName}, ${address.addressLine1}, ${address.city}`,
            }))}
            defaultEmail={user?.email ?? ""}
          />
        </div>
      )}
    </div>
  );
}
