import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { IconCart } from "@/components/icons";
import { PageHeading } from "@/components/page-heading";
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

  const lineCount = cart?.lines.length ?? 0;
  const itemCount =
    cart?.lines.reduce((total, line) => total + line.quantity, 0) ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-10 md:px-6 md:py-12">
      <PageHeading
        eyebrow="Your basket"
        title="Your cart"
        summary={
          lineCount === 0
            ? "Nothing here yet."
            : `${itemCount} item${itemCount === 1 ? "" : "s"} across ${lineCount} line${
                lineCount === 1 ? "" : "s"
              }. Every price already carries shipping and customs duty.`
        }
      />

      {!cart || cart.lines.length === 0 ? (
        /* An empty cart links somewhere, never to nowhere. */
        <EmptyState
          className="mt-8 max-w-[720px]"
          icon={<IconCart size={26} />}
          title="Your cart is empty"
          body="Browse the open preorders and add something you cannot get locally. Nothing is charged until you check out, and nothing is bought until the batch closes."
          action={{ href: "/search?available=1", label: "See what is open" }}
          secondary={{ href: "/", label: "Back to the shop" }}
        />
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
              fulfillmentMode: line.fulfillmentMode,
              paymentMode: line.paymentMode,
              depositPercent: line.depositPercent,
              available: line.available,
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
