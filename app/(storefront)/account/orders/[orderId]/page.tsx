import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LandedBreakdown } from "@/components/landed-breakdown";
import { OrderProgress } from "@/components/order-progress";
import { getCurrentUser } from "@/lib/auth";
import { getOrderForUser } from "@/lib/orders";
import { formatBdt } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { CancelOrderButton } from "./cancel-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order",
  robots: { index: false },
};

export default async function AccountOrderPage({
  params,
}: PageProps<"/account/orders/[orderId]">) {
  const { orderId } = await params;
  const user = await getCurrentUser();
  const order = await getOrderForUser(user, orderId);

  if (!order) notFound();

  /*
   * A shopper may ask to cancel while the order is still running. It is a
   * request rather than a cancellation — staff decide (DECISIONS.md D-014) —
   * so it stays available after sourcing, which is exactly the case where
   * somebody needs to talk to us.
   */
  const canCancel = !["cancelled", "refunded", "delivered"].includes(
    order.status,
  );

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-8 md:px-6">
      <p className="text-meta text-blue-600">
        <Link href="/account" className="hover:underline">
          Your orders
        </Link>
      </p>
      <h1 className="mt-2 font-display text-h1 tabular-nums text-ink">
        {order.orderNumber}
      </h1>
      <p className="mt-2 text-meta text-ink/70">
        Placed {formatDate(order.placedAt)}
      </p>

      <div className="mt-8">
        <OrderProgress status={order.status} history={order.history} />
      </div>

      <section className="mt-10">
        <h2 className="font-display text-h2 text-ink">Items</h2>
        <ul className="mt-4 border-t border-blue-300">
          {order.items.map((item) => (
            <li
              key={item.id}
              className="flex justify-between gap-4 border-b border-blue-300 py-3"
            >
              <div>
                <p className="text-body text-ink">{item.titleSnapshot}</p>
                <p className="text-meta text-ink/70">
                  {item.optionSummarySnapshot
                    ? `${item.optionSummarySnapshot} · `
                    : ""}
                  Quantity {item.quantity}
                </p>
              </div>
              <p className="tabular-nums text-ink">
                {formatBdt(item.unitPriceBdt * item.quantity)}
              </p>
            </li>
          ))}
        </ul>

        <dl className="mt-4 flex flex-col gap-2 text-body">
          <LandedBreakdown
            goodsBdt={order.subtotalBdt}
            shippingBdt={order.shippingFeeBdt}
            dutyBdt={order.dutyBdt}
            totalBdt={order.totalBdt}
          />
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Paid</dt>
            <dd className="tabular-nums text-ink">
              {formatBdt(order.amountDueNowBdt)}
            </dd>
          </div>
        </dl>
      </section>

      {order.trackingReference ? (
        <section className="mt-10">
          <h2 className="font-display text-h2 text-ink">Tracking</h2>
          <p className="mt-2 text-body text-ink">
            Reference{" "}
            <span className="font-medium tabular-nums">
              {order.trackingReference}
            </span>
          </p>
          <p className="mt-1 text-meta text-ink/70">
            Quote this if you need to ask the courier about your delivery.
          </p>
        </section>
      ) : null}

      {order.address ? (
        <section className="mt-10">
          <h2 className="font-display text-h2 text-ink">Delivering to</h2>
          <address className="mt-3 not-italic text-body text-ink/80">
            {order.address.recipientName}
            <br />
            {order.address.addressLine1}
            {order.address.addressLine2 ? (
              <>
                <br />
                {order.address.addressLine2}
              </>
            ) : null}
            <br />
            {order.address.city}, {order.address.district}
            <br />
            {order.address.phone}
          </address>
        </section>
      ) : null}

      {canCancel ? (
        <section className="mt-10 border-t border-blue-300 pt-6">
          <h2 className="font-display text-h3 text-ink">Need to cancel?</h2>
          <p className="mt-2 max-w-[60ch] text-meta text-ink/70">
            Ask us and we will look at it with you. If we have not yet bought
            your item in the US it is usually straightforward; after that it
            depends on where the batch has got to.
          </p>
          <div className="mt-4">
            <CancelOrderButton
              orderId={order.id}
              requestedAt={
                order.cancellationRequestedAt
                  ? order.cancellationRequestedAt.toISOString()
                  : null
              }
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
