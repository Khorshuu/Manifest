import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { addresses } from "@/db/schema";
import { CheckoutSteps } from "@/components/checkout-steps";
import { EmptyState } from "@/components/empty-state";
import { IconAlert } from "@/components/icons";
import { PageHeading } from "@/components/page-heading";
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
        // The default first, so the checkout's saved-address choice opens on it.
        .orderBy(desc(addresses.isDefault), asc(addresses.createdAt))
    : [];

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-10 md:px-6 md:py-12">
      <PageHeading
        eyebrow="Almost there"
        title="Checkout"
        summary="Where it goes and how you pay. The price you see is the price you pay — the courier asks for nothing at the door."
      />

      <CheckoutSteps current="details" />

      {cart.hasProblems ? (
        <EmptyState
          className="mt-8 max-w-[720px]"
          icon={<IconAlert size={26} />}
          title="Some items changed"
          body="A batch closed or filled up while these were in your cart. Review them and they can go through."
          action={{ href: "/cart", label: "Back to cart" }}
        />
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
            lines={cart.lines.map((line) => ({
              itemId: line.itemId,
              title: line.productTitle,
              optionSummary: line.optionSummary,
              quantity: line.quantity,
              lineTotalBdt: line.lineTotalBdt,
              imageUrl: line.imageUrl,
              slug: line.productSlug,
            }))}
          />
        </div>
      )}
    </div>
  );
}
