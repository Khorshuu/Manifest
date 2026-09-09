import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { getCurrentUser } from "@/lib/auth";
import { listCancellationRequests, listOrdersForStaff } from "@/lib/orders";
import { formatBdt } from "@/lib/money";
import { formatShortDate } from "@/lib/format";
import type { OrderStatus } from "@/db/schema";

export const metadata: Metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

/*
 * "Cancellation requested" is not an order status — the order carries on in
 * whatever stage it was in while somebody decides. It is a queue of orders
 * whose shoppers have asked to stop, which is a different question from where
 * an order has got to, and it sits first because it is the only filter here
 * that is waiting on a person.
 */
type Filter = OrderStatus | "all" | "cancellation_requested";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "cancellation_requested", label: "Cancellation requested" },
  { value: "all", label: "All" },
  { value: "placed", label: "Awaiting payment" },
  { value: "payment_confirmed", label: "Paid" },
  { value: "sourcing", label: "Sourcing" },
  { value: "shipped_from_us", label: "Shipped from US" },
  { value: "in_bd_customs", label: "In customs" },
  { value: "out_for_delivery", label: "Out for delivery" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
];

const LABELS: Record<string, string> = Object.fromEntries(
  FILTERS.map((filter) => [filter.value, filter.label]),
);

export default async function AdminOrdersPage({
  searchParams,
}: PageProps<"/admin/orders">) {
  const params = await searchParams;
  const status = typeof params.status === "string" ? params.status : "all";

  const user = await getCurrentUser();
  const showingRequests = status === "cancellation_requested";

  const requests = showingRequests
    ? await listCancellationRequests(user)
    : [];
  const orders = showingRequests
    ? []
    : await listOrdersForStaff(
        user,
        status === "all" ? {} : { status: status as OrderStatus },
      );

  // The count sits on the tab whether or not it is the one being viewed, so a
  // waiting customer is visible from any of them.
  const waitingCount = (await listCancellationRequests(user)).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Operations
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Orders</h1>
      </div>

      <nav aria-label="Filter by status">
        <ul className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <li key={filter.value}>
              <Link
                href={`/admin/orders?status=${filter.value}`}
                aria-current={status === filter.value ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-control border px-3 text-meta ${
                  status === filter.value
                    ? "border-blue-600 text-blue-600"
                    : "border-blue-300 text-ink"
                }`}
              >
                {filter.label}
                {filter.value === "cancellation_requested" &&
                waitingCount > 0 ? (
                  <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-card bg-stamp-red px-1 font-medium tabular-nums text-paper">
                    {waitingCount}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {showingRequests ? (
        requests.length === 0 ? (
          <div className="surface-paper rounded-card border border-blue-300 p-8">
            <p className="text-body text-ink">
              Nobody is waiting on a cancellation.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {requests.map((request) => (
              <li
                key={request.id}
                className="border border-blue-300 bg-paper p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/admin/orders/${request.id}`}
                      className="font-display text-h3 tabular-nums text-blue-600 hover:underline"
                    >
                      {request.orderNumber}
                    </Link>
                    <p className="mt-1 text-meta text-ink/70">
                      Asked{" "}
                      {request.requestedAt
                        ? formatShortDate(request.requestedAt)
                        : "—"}
                      {" · currently "}
                      {LABELS[request.status] ?? request.status}
                    </p>
                  </div>
                  <p className="tabular-nums text-ink">
                    {formatBdt(request.totalBdt)}
                  </p>
                </div>

                {/* The customer's own words, which is usually what decides it. */}
                <p className="mt-3 max-w-[70ch] border-l-2 border-brass pl-3 text-body text-ink/80">
                  {request.reason?.trim()
                    ? request.reason
                    : "No reason given."}
                </p>

                <p className="mt-3 text-meta text-ink/70">
                  Open the order to approve or decline this.
                </p>
              </li>
            ))}
          </ul>
        )
      ) : orders.length === 0 ? (
        <div className="surface-paper rounded-card border border-blue-300 p-8">
          <p className="text-body text-ink">No orders with that status.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-card border border-blue-300 shadow-[var(--shadow-raise)]">
          <table className="w-full min-w-[720px] border-collapse text-body">
            <thead>
              <tr className="bg-paper-raised text-left">
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Order
                </th>
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Placed
                </th>
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Customer
                </th>
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Status
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-meta font-medium"
                >
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order, index) => (
                <tr
                  key={order.id}
                  className={index % 2 === 1 ? "bg-blue-200/40" : undefined}
                >
                  <td className="border-t border-blue-300 px-4 py-3">
                    <Link
                      href={`/admin/orders/${order.id}`}
                      className="tabular-nums text-blue-600 hover:underline"
                    >
                      {order.orderNumber}
                    </Link>
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3 text-meta text-ink/70">
                    {formatShortDate(order.placedAt)}
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3 text-meta text-ink/70">
                    {order.guestEmail ?? (order.userId ? "Account" : "—")}
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3">
                    <StatusBadge
                      tone={
                        order.status === "delivered"
                          ? "positive"
                          : order.status === "cancelled" ||
                              order.status === "refunded"
                            ? "negative"
                            : "preorder"
                      }
                    >
                      {LABELS[order.status] ?? order.status}
                    </StatusBadge>
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3 text-right tabular-nums">
                    {formatBdt(order.totalBdt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
