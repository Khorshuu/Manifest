import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft } from "@/components/icons";
import { OrderProgress } from "@/components/order-progress";
import { Panel } from "@/components/panel";
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
    <div className="mx-auto w-full max-w-[900px] px-4 py-10 md:px-6 md:py-12">
      <Link
        href="/account"
        className="inline-flex items-center gap-2 text-meta text-blue-600 underline-offset-4 hover:underline"
      >
        <IconArrowLeft size={16} />
        Your orders
      </Link>

      <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
            <span aria-hidden="true" className="h-px w-8 bg-brass" />
            Order
          </p>
          <h1 className="mt-2 font-display text-h1 tabular-nums text-ink">
            {order.orderNumber}
          </h1>
          <p className="mt-1 text-meta text-ink/70">
            Placed {formatDate(order.placedAt)}
          </p>
        </div>

        {order.trackingReference ? (
          <Panel tone="raised" className="px-4 py-3">
            <p className="text-meta text-ink/70">Tracking reference</p>
            <p className="font-medium tabular-nums text-ink">
              {order.trackingReference}
            </p>
            <p className="mt-1 max-w-[32ch] text-meta text-ink/70">
              Quote this if you need to ask the courier about your delivery.
            </p>
          </Panel>
        ) : null}
      </div>

      <Panel depth="raised" className="mt-8 p-5 sm:p-6">
        <OrderProgress status={order.status} history={order.history} />
      </Panel>

      <div className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0">
          <h2 className="font-display text-h2 text-ink">Items</h2>

          <Panel className="mt-4 overflow-hidden">
            <ul>
              {order.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap justify-between gap-4 border-b border-blue-200 px-5 py-4 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="text-body text-ink">{item.titleSnapshot}</p>
                    <p className="text-meta text-ink/70">
                      {item.optionSummarySnapshot
                        ? `${item.optionSummarySnapshot} · `
                        : ""}
                      {item.quantity > 1
                        ? `${item.quantity} × ${formatBdt(item.unitPriceBdt)}`
                        : "Quantity 1"}
                    </p>
                  </div>
                  <p className="tabular-nums font-medium text-ink">
                    {formatBdt(item.unitPriceBdt * item.quantity)}
                  </p>
                </li>
              ))}
            </ul>

            {/*
             * The customer sees the price of each item and the total — the
             * figures they agreed to. How the landed price divides into goods,
             * freight and duty is the shop's bookkeeping and stays in the
             * admin; here it is one plain line that nothing more is owed.
             */}
            <dl className="flex flex-col gap-1.5 border-t border-blue-300 bg-paper-raised px-5 py-4 text-body">
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-ink">Total</dt>
                <dd className="tabular-nums font-semibold text-ink">
                  {formatBdt(order.totalBdt)}
                </dd>
              </div>
              {order.amountDueNowBdt !== order.totalBdt ? (
                <div className="flex justify-between gap-4 text-meta">
                  <dt className="text-ink/70">Paid so far</dt>
                  <dd className="tabular-nums text-ink">
                    {formatBdt(order.amountDueNowBdt)}
                  </dd>
                </div>
              ) : null}
              <p className="text-meta text-ink/70">
                Shipping and customs duty are included. Nothing more to pay on
                delivery.
              </p>
            </dl>
          </Panel>
        </section>

        {order.address ? (
          <Panel as="section" depth="raised" className="p-5">
            <h2 className="font-display text-h3 text-ink">Delivering to</h2>
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
          </Panel>
        ) : null}
      </div>

      {canCancel ? (
        <section className="mt-12 border-t border-ink/15 pt-8">
          <h2 className="font-display text-h3 text-ink">Need to cancel?</h2>
          <p className="mt-2 max-w-[62ch] text-meta text-ink/70">
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
