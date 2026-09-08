import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderProgress } from "@/components/order-progress";
import { allowedTransitions, getOrderForStaff } from "@/lib/orders";
import { formatBdt } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { OrderActions } from "./order-actions";
import { ShippingPanel } from "./shipping-panel";

export const metadata: Metadata = { title: "Order" };
export const dynamic = "force-dynamic";

export default async function AdminOrderPage({
  params,
}: PageProps<"/admin/orders/[orderId]">) {
  const { orderId } = await params;
  const order = await getOrderForStaff(orderId);

  if (!order) notFound();

  const allowed = allowedTransitions(order.status);
  const canRefund = allowed.includes("refunded");

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="text-meta text-blue-400">
          <Link href="/admin/orders" className="hover:underline">
            Orders
          </Link>
        </p>
        <h1 className="mt-2 font-display text-h1 tabular-nums text-ink">
          {order.orderNumber}
        </h1>
        <p className="mt-2 text-meta text-ink/70">
          Placed {formatDate(order.placedAt)}
        </p>
      </div>

      <OrderProgress status={order.status} history={order.history} />

      <div className="grid items-start gap-8 lg:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-8">
          <section>
            <h2 className="font-display text-h2 text-ink">Items</h2>
            <div className="mt-4 overflow-x-auto border border-blue-300">
              <table className="w-full min-w-[480px] border-collapse text-body">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="px-4 py-3 text-meta font-medium">
                      Item
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right text-meta font-medium"
                    >
                      Qty
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right text-meta font-medium"
                    >
                      Line total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item, index) => (
                    <tr
                      key={item.id}
                      className={index % 2 === 1 ? "bg-blue-200/40" : undefined}
                    >
                      <td className="border-t border-blue-300 px-4 py-3">
                        {item.titleSnapshot}
                        {item.optionSummarySnapshot ? (
                          <span className="block text-meta text-ink/60">
                            {item.optionSummarySnapshot}
                          </span>
                        ) : null}
                      </td>
                      <td className="border-t border-blue-300 px-4 py-3 text-right tabular-nums">
                        {item.quantity}
                      </td>
                      <td className="border-t border-blue-300 px-4 py-3 text-right tabular-nums">
                        {formatBdt(item.unitPriceBdt * item.quantity)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="font-display text-h2 text-ink">History</h2>
            <ul className="mt-4 border-t border-blue-300">
              {order.history.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap justify-between gap-3 border-b border-blue-300 py-3"
                >
                  <div>
                    <p className="text-body text-ink">
                      {entry.status.replace(/_/g, " ")}
                    </p>
                    {entry.note ? (
                      <p className="text-meta text-ink/60">{entry.note}</p>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <p className="text-meta text-ink/70">
                      {formatDate(entry.createdAt)}
                    </p>
                    {/* Null actor means the gateway or a job drove it. */}
                    <p className="text-meta text-ink/50">
                      {entry.actorUserId ? "Staff" : "System"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="font-display text-h2 text-ink">Payments</h2>
            <ul className="mt-4 border-t border-blue-300">
              {order.payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex flex-wrap justify-between gap-3 border-b border-blue-300 py-3"
                >
                  <div>
                    <p className="text-body text-ink">
                      {payment.kind} · {payment.status}
                    </p>
                    <p className="font-mono text-meta text-ink/60">
                      {payment.providerRef}
                    </p>
                  </div>
                  <p className="tabular-nums text-ink">
                    {formatBdt(payment.amountBdt)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="flex h-fit min-w-0 flex-col gap-6">
          <section className="border border-blue-300 p-5">
            <h2 className="font-display text-h3 text-ink">Move this order on</h2>
            <div className="mt-4">
              {allowed.length === 0 ? (
                <p className="text-meta text-ink/70">
                  This order has reached a final state.
                </p>
              ) : (
                <OrderActions
                  orderId={order.id}
                  allowed={allowed}
                  canRefund={canRefund}
                />
              )}
            </div>
          </section>

          <section className="border border-blue-300 p-5">
            <h2 className="font-display text-h3 text-ink">Shipping</h2>
            <div className="mt-4">
              <ShippingPanel
                key={order.trackingReference ?? "unbooked"}
                orderId={order.id}
                trackingReference={order.trackingReference}
                internalNotes={order.internalNotes}
              />
            </div>
          </section>

          <section className="border border-blue-300 p-5">
            <h2 className="font-display text-h3 text-ink">Delivery</h2>
            {order.address ? (
              <address className="mt-3 not-italic text-meta text-ink/80">
                {order.address.recipientName}
                <br />
                {order.address.addressLine1}
                <br />
                {order.address.city}, {order.address.district}
                <br />
                {order.address.phone}
              </address>
            ) : (
              <p className="mt-3 text-meta text-ink/70">No address recorded.</p>
            )}
          </section>

          <section className="border border-blue-300 p-5">
            <h2 className="font-display text-h3 text-ink">Totals</h2>
            <dl className="mt-3 flex flex-col gap-2 text-meta">
              {/* What the landed price is made of, as recorded at placement. */}
              <div className="flex justify-between gap-4">
                <dt className="text-ink/70">Goods</dt>
                <dd className="tabular-nums text-ink">
                  {formatBdt(order.subtotalBdt)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink/70">Shipping</dt>
                <dd className="tabular-nums text-ink">
                  {formatBdt(order.shippingFeeBdt)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink/70">Duty</dt>
                <dd className="tabular-nums text-ink">
                  {formatBdt(order.dutyBdt)}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-blue-300 pt-2">
                <dt className="text-ink/70">Order total</dt>
                <dd className="tabular-nums text-ink">
                  {formatBdt(order.totalBdt)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink/70">Collected</dt>
                <dd className="tabular-nums text-ink">
                  {formatBdt(order.amountDueNowBdt)}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
