import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orders, payments } from "@/db/schema";
import { OrderProgress } from "@/components/order-progress";
import { formatBdt } from "@/lib/money";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order confirmed",
  robots: { index: false },
};

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
    <div className="mx-auto w-full max-w-[720px] px-4 py-12 md:px-6">
      <p className="text-meta text-transit-green-text">Order confirmed</p>
      <h1 className="mt-2 font-display text-h1 text-ink">
        Thank you — we have your order
      </h1>
      <p className="mt-3 max-w-[60ch] text-body text-ink/80">
        Your order number is{" "}
        <span className="font-medium tabular-nums">{order.orderNumber}</span>.
        Keep it: you can look your order up with it and the email address you
        gave us.
      </p>

      <div className="mt-8">
        <OrderProgress status={order.status} />
      </div>

      <section className="mt-10">
        <h2 className="font-display text-h2 text-ink">What you ordered</h2>
        <ul className="mt-4 border-t border-blue-300">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex justify-between gap-4 border-b border-blue-300 py-3"
            >
              <div>
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

        <dl className="mt-4 flex flex-col gap-2 text-body">
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Order total</dt>
            <dd className="tabular-nums text-ink">
              {formatBdt(order.totalBdt)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Paid now</dt>
            <dd className="tabular-nums text-ink">
              {formatBdt(order.amountDueNowBdt)}
            </dd>
          </div>
        </dl>
      </section>

      {payment && payment.status !== "captured" ? (
        <p className="mt-8 text-meta text-ink/70">
          Payment reference{" "}
          <span className="tabular-nums">{payment.providerRef}</span>. In
          development the mock gateway confirms payment separately.
        </p>
      ) : null}

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
        >
          Keep browsing
        </Link>
        <Link
          href={`/orders/lookup?order=${order.orderNumber}`}
          className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
        >
          Track this order
        </Link>
      </div>
    </div>
  );
}
