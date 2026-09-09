import type { Metadata } from "next";
import { LandedBreakdown } from "@/components/landed-breakdown";
import { OrderProgress } from "@/components/order-progress";
import { getBalanceState, getGuestOrder } from "@/lib/orders";
import { formatBdt } from "@/lib/money";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Track your order",
  robots: { index: false },
};

export default async function OrderLookupPage({
  searchParams,
}: PageProps<"/orders/lookup">) {
  const params = await searchParams;
  const orderNumber = typeof params.order === "string" ? params.order : "";
  const email = typeof params.email === "string" ? params.email : "";

  // Both are required: an order number alone must not reveal an order.
  const order =
    orderNumber && email ? await getGuestOrder(orderNumber, email) : null;
  const balance = order ? await getBalanceState(order.id) : null;
  const searched = Boolean(orderNumber && email);

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-12 md:px-6">
      <h1 className="font-display text-h1 text-ink">Track your order</h1>
      <p className="mt-3 max-w-[60ch] text-body text-ink/80">
        Enter your order number and the email address you used at checkout.
      </p>

      <form className="mt-8 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label htmlFor="order" className="text-meta font-medium text-ink">
            Order number
          </label>
          <input
            id="order"
            name="order"
            defaultValue={orderNumber}
            required
            className="min-h-11 rounded-control border border-blue-300 px-3 text-body tabular-nums"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="email" className="text-meta font-medium text-ink">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={email}
            required
            className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
          />
        </div>

        <div>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-control bg-brass px-5 text-body font-medium text-ink"
          >
            Find my order
          </button>
        </div>
      </form>

      <div aria-live="polite" className="mt-10">
        {searched && !order ? (
          <div className="border border-blue-300 p-5">
            <p className="text-body text-ink">
              We could not find an order with those details.
            </p>
            <p className="mt-2 text-meta text-ink/70">
              Check the order number and that the email matches the one used at
              checkout.
            </p>
          </div>
        ) : null}

        {order ? (
          <section>
            <h2 className="font-display text-h2 text-ink">
              Order {order.orderNumber}
            </h2>
            <p className="mt-1 text-meta text-ink/70">
              Placed {formatDate(order.placedAt)}
            </p>

            <div className="mt-6">
              <OrderProgress status={order.status} history={order.history} />
            </div>

            {order.trackingReference ? (
              <p className="mt-6 text-body text-ink">
                Tracking reference{" "}
                <span className="font-medium tabular-nums">
                  {order.trackingReference}
                </span>
              </p>
            ) : null}

            <ul className="mt-8 border-t border-blue-300">
              {order.items.map((item) => (
                <li
                  key={item.id}
                  className="flex justify-between gap-4 border-b border-blue-300 py-3"
                >
                  <div>
                    <p className="text-body text-ink">{item.titleSnapshot}</p>
                    <p className="text-meta text-ink/70">
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
            </dl>

            {/*
              A deposit order still owes something, and the customer should not
              have to work that out from two figures. The balance is taken by
              us rather than by them (DECISIONS.md D-012), so this says what is
              left and that we will collect it — not "pay now", which would be
              a button that does not exist.
            */}
            {balance && balance.outstandingBdt > 0 ? (
              <div className="mt-4 border border-brass/60 bg-paper-raised p-4">
                <p className="text-body text-ink">
                  <span className="font-medium tabular-nums">
                    {formatBdt(balance.outstandingBdt)}
                  </span>{" "}
                  still to pay on this order.
                </p>
                <p className="mt-1 text-meta text-ink/70">
                  You paid {formatBdt(balance.paidBdt)} as a deposit. We take
                  the rest before the batch is dispatched, and write to you when
                  we do. There is nothing to settle with the courier.
                </p>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
