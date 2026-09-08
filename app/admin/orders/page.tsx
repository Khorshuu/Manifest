import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { getCurrentUser } from "@/lib/auth";
import { listOrdersForStaff } from "@/lib/orders";
import { formatBdt } from "@/lib/money";
import { formatShortDate } from "@/lib/format";
import type { OrderStatus } from "@/db/schema";

export const metadata: Metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

const FILTERS: { value: OrderStatus | "all"; label: string }[] = [
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
  const orders = await listOrdersForStaff(
    user,
    status === "all" ? {} : { status: status as OrderStatus },
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-meta text-blue-600">Operations</p>
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
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {orders.length === 0 ? (
        <div className="border border-blue-300 p-8">
          <p className="text-body text-ink">No orders with that status.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-blue-300">
          <table className="w-full min-w-[720px] border-collapse text-body">
            <thead>
              <tr className="text-left">
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
