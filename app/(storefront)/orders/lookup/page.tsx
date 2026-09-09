import type { Metadata } from "next";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { IconAlert, IconManifest } from "@/components/icons";
import { LandedBreakdown } from "@/components/landed-breakdown";
import { OrderProgress } from "@/components/order-progress";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
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
    <div className="mx-auto w-full max-w-[820px] px-4 py-10 md:px-6 md:py-12">
      <PageHeading
        eyebrow="Where is it"
        title="Track your order"
        summary="Enter your order number and the email address you used at checkout. No account needed."
      />

      <Panel depth="raised" className="mt-8 p-5 sm:p-6">
        <form className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Order number"
              id="order"
              name="order"
              defaultValue={orderNumber}
              required
              inputMode="numeric"
              className="tabular-nums"
            />
            <Field
              label="Email"
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={email}
              required
            />
          </div>

          <div>
            <Button type="submit">Find my order</Button>
          </div>
        </form>
      </Panel>

      <div aria-live="polite" className="mt-10">
        {searched && !order ? (
          <EmptyState
            icon={<IconAlert size={26} />}
            title="We could not find that order"
            body="Check the order number, and that the email matches the one used at checkout. If you were signed in when you ordered, it is on your account page instead."
            action={{ href: "/account", label: "Your account" }}
          />
        ) : null}

        {order ? (
          <section>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
                  <span aria-hidden="true" className="h-px w-8 bg-brass" />
                  Found it
                </p>
                <h2 className="mt-2 font-display text-h1 text-ink">
                  Order <span className="tabular-nums">{order.orderNumber}</span>
                </h2>
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
                </Panel>
              ) : null}
            </div>

            <Panel depth="raised" className="mt-6 p-5 sm:p-6">
              <OrderProgress status={order.status} history={order.history} />
            </Panel>

            <h3 className="mt-10 font-display text-h2 text-ink">
              What is in it
            </h3>
            <Panel className="mt-4 overflow-hidden">
              <ul>
                {order.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap justify-between gap-4 border-b border-blue-200 px-5 py-4 last:border-b-0"
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

              <dl className="flex flex-col gap-2 border-t border-blue-300 bg-paper-raised px-5 py-4 text-body">
                <LandedBreakdown
                  goodsBdt={order.subtotalBdt}
                  shippingBdt={order.shippingFeeBdt}
                  dutyBdt={order.dutyBdt}
                  totalBdt={order.totalBdt}
                />
              </dl>
            </Panel>

            {/*
              A deposit order still owes something, and the customer should not
              have to work that out from two figures. The balance is taken by
              us rather than by them (DECISIONS.md D-012), so this says what is
              left and that we will collect it — not "pay now", which would be
              a button that does not exist.
            */}
            {balance && balance.outstandingBdt > 0 ? (
              <Panel
                tone="raised"
                depth="raised"
                className="mt-6 border-brass/60 p-5"
              >
                <div className="flex items-start gap-3">
                  <IconManifest size={22} className="mt-0.5 shrink-0 text-brass-text" />
                  <div>
                    <p className="text-body text-ink">
                      <span className="font-medium tabular-nums">
                        {formatBdt(balance.outstandingBdt)}
                      </span>{" "}
                      still to pay on this order.
                    </p>
                    <p className="mt-1 max-w-[62ch] text-meta text-ink/70">
                      You paid {formatBdt(balance.paidBdt)} as a deposit. We
                      take the rest before the batch is dispatched, and write to
                      you when we do. There is nothing to settle with the
                      courier.
                    </p>
                  </div>
                </div>
              </Panel>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
