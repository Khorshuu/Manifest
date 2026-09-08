import type { Metadata } from "next";
import { OrderProgress } from "@/components/order-progress";
import { getGuestOrder } from "@/lib/orders";
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

            <ul className="mt-8 border-t border-blue-300">
              {order.items.map((item) => (
                <li
                  key={item.id}
                  className="flex justify-between gap-4 border-b border-blue-300 py-3"
                >
                  <div>
                    <p className="text-body text-ink">{item.titleSnapshot}</p>
                    <p className="text-meta text-ink/60">
                      Quantity {item.quantity}
                    </p>
                  </div>
                  <p className="tabular-nums text-ink">
                    {formatBdt(item.unitPriceBdt * item.quantity)}
                  </p>
                </li>
              ))}
            </ul>

            <p className="mt-4 text-body text-ink">
              Total{" "}
              <span className="tabular-nums font-medium">
                {formatBdt(order.totalBdt)}
              </span>
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
