import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orders, payments } from "@/db/schema";
import { LinkButton } from "@/components/button";
import { CheckoutSteps } from "@/components/checkout-steps";
import { IconCheck, IconClock, IconSeal, IconTruck } from "@/components/icons";
import { OrderProgress } from "@/components/order-progress";
import { Panel } from "@/components/panel";
import { formatBdt } from "@/lib/money";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order confirmed",
  robots: { index: false },
};

/**
 * What happens next, in the order it happens.
 *
 * The confirmation page is read once, in a slightly anxious frame of mind, by
 * someone who has just paid for something that does not exist yet. Restating
 * the sequence here costs nothing and answers the question they are actually
 * holding.
 */
const NEXT = [
  {
    icon: IconClock,
    title: "The window finishes",
    body: "Your place in the batch is held. Nothing else is needed from you.",
  },
  {
    icon: IconSeal,
    title: "We buy and clear it",
    body: "One order for the whole batch, then customs — duty is already paid inside your price.",
  },
  {
    icon: IconTruck,
    title: "A courier brings it",
    body: "To the address you gave, with a tracking reference. Nothing to settle at the door.",
  },
];

export default async function ConfirmationPage({
  searchParams,
}: PageProps<"/checkout/confirmation">) {
  const params = await searchParams;
  const orderNumber = typeof params.order === "string" ? params.order : "";
  if (!orderNumber) notFound();

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);

  if (!order) notFound();

  const [items, paymentRows] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
    db.select().from(payments).where(eq(payments.orderId, order.id)),
  ]);

  const payment = paymentRows[0];

  return (
    <div className="mx-auto w-full max-w-[860px] px-4 py-10 md:px-6 md:py-14">
      <CheckoutSteps current="done" />

      {/*
       * The one moment on the site that is allowed to celebrate. The mark
       * stamps down the way an order checkpoint does, which is the same
       * gesture the tracker uses further down the page — so the confirmation
       * and the tracking read as one system rather than two.
       */}
      <div className="mt-8 flex items-start gap-4">
        <span
          aria-hidden="true"
          className="animate-stamp inline-flex size-12 shrink-0 items-center justify-center rounded-card border border-transit-green bg-transit-green text-paper shadow-[var(--shadow-raise)] sm:size-14"
        >
          <IconCheck size={28} />
        </span>

        <div>
          <p className="text-meta uppercase tracking-[0.18em] text-transit-green-text">
            Order confirmed
          </p>
          <h1 className="mt-1.5 font-display text-h1 text-ink">
            Thank you — we have your order
          </h1>
        </div>
      </div>

      <Panel depth="raised" tone="raised" className="mt-8 p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-meta text-ink/70">Your order number</p>
            <p className="mt-1 font-display text-h1 tabular-nums text-ink">
              {order.orderNumber}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <LinkButton
              href={`/orders/lookup?order=${order.orderNumber}`}
              variant="primary"
            >
              Track this order
            </LinkButton>
            <LinkButton href="/search?available=1" variant="secondary">
              Keep browsing
            </LinkButton>
          </div>
        </div>

        <p className="mt-4 max-w-[62ch] text-meta text-ink/70">
          Keep it: you can look your order up with this number and the email
          address you gave us, without signing in.
        </p>
      </Panel>

      <section className="mt-10">
        <h2 className="font-display text-h2 text-ink">Where it is</h2>
        <div className="mt-5">
          <OrderProgress status={order.status} />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-h2 text-ink">What happens next</h2>
        <ol className="mt-5 grid gap-px overflow-hidden rounded-card border border-ink/15 bg-ink/15 sm:grid-cols-3">
          {NEXT.map(({ icon: Glyph, title, body }) => (
            <li key={title} className="bg-paper p-5">
              <Glyph size={22} className="text-blue-500" />
              <h3 className="mt-3 font-display text-h3 text-ink">{title}</h3>
              <p className="mt-1.5 text-meta text-ink/70">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-h2 text-ink">What you ordered</h2>

        <Panel className="mt-5 overflow-hidden">
          <ul>
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap justify-between gap-4 border-b border-blue-200 px-5 py-4 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-body text-ink">{item.titleSnapshot}</p>
                  <p className="text-meta text-ink/70">
                    Quantity {item.quantity}
                    {item.estimatedArrivalSnapshot
                      ? ` · expected ${formatDate(item.estimatedArrivalSnapshot)}`
                      : ""}
                  </p>
                </div>
                <p className="tabular-nums text-ink">
                  {formatBdt(item.unitPriceBdt * item.quantity)}
                </p>
              </li>
            ))}
          </ul>

          <dl className="flex flex-col gap-2 border-t border-blue-300 bg-paper-raised px-5 py-4 text-body">
            <div className="flex justify-between gap-4">
              <dt className="text-ink/70">Order total</dt>
              <dd className="tabular-nums text-ink">
                {formatBdt(order.totalBdt)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="font-medium text-ink">Paid now</dt>
              <dd className="font-display text-price font-semibold tabular-nums text-ink">
                {formatBdt(order.amountDueNowBdt)}
              </dd>
            </div>
          </dl>
        </Panel>
      </section>

      {payment && payment.status !== "captured" ? (
        <p className="mt-8 text-meta text-ink/70">
          Payment reference{" "}
          <span className="tabular-nums">{payment.providerRef}</span>. In
          development the mock gateway confirms payment separately.
        </p>
      ) : null}
    </div>
  );
}
