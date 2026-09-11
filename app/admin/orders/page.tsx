import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { listCancellationRequests, searchOrdersForStaff } from "@/lib/orders";
import { formatBdt } from "@/lib/money";
import { formatShortDate } from "@/lib/format";
import { ORDER_STATUSES, type OrderStatus } from "@/db/schema";
import { ORDER_STATUS_LABELS, orderStatusTone, paymentLabel } from "../order-status";

export const metadata: Metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "total_desc", label: "Highest total" },
  { value: "total_asc", label: "Lowest total" },
] as const;

type Sort = (typeof SORTS)[number]["value"];

function parseDay(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Every order, searchable and filterable.
 *
 * The state lives in the address, so a filtered list can be bookmarked or
 * sent to a colleague. "Cancellation requested" is not a status — the order
 * carries on while somebody decides — so it is its own view, first, because
 * it is the only one waiting on a person.
 */
export default async function AdminOrdersPage({
  searchParams,
}: PageProps<"/admin/orders">) {
  const user = await requireAdminPage("orders.view");
  const params = await searchParams;

  const status = typeof params.status === "string" ? params.status : "all";
  const q = typeof params.q === "string" ? params.q.slice(0, 80) : "";
  const sort: Sort = SORTS.some((option) => option.value === params.sort)
    ? (params.sort as Sort)
    : "newest";
  const fromDay = typeof params.from === "string" ? params.from : "";
  const toDay = typeof params.to === "string" ? params.to : "";
  const from = parseDay(fromDay);
  const toStart = parseDay(toDay);
  const to = toStart ? new Date(toStart.getTime() + 24 * 60 * 60 * 1000) : undefined;
  const page = Math.max(1, Number(params.page) || 1);

  const showingRequests = status === "cancellation_requested";
  const validStatus = (ORDER_STATUSES as readonly string[]).includes(status)
    ? (status as OrderStatus)
    : undefined;

  const [requests, result] = await Promise.all([
    listCancellationRequests(user),
    showingRequests
      ? null
      : searchOrdersForStaff(user, {
          q,
          status: validStatus,
          from,
          to,
          sort,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        }),
  ]);

  const keep = (overrides: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const base: Record<string, string> = { status, q, sort, from: fromDay, to: toDay };
    for (const [key, value] of Object.entries({ ...base, ...overrides })) {
      if (value && !(key === "status" && value === "all") && !(key === "sort" && value === "newest")) {
        next.set(key, value);
      }
    }
    const query = next.toString();
    return query ? `/admin/orders?${query}` : "/admin/orders";
  };

  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const filtered = Boolean(q || validStatus || from || to);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="admin-h1">Orders</h1>
          <p className="mt-0.5 text-meta text-ink/70">
            {showingRequests
              ? `${requests.length} waiting on a decision`
              : `${result?.total ?? 0} order${result?.total === 1 ? "" : "s"}${filtered ? " match" : ""}`}
          </p>
        </div>
      </div>

      <nav aria-label="Filter by status" className="-mx-1 overflow-x-auto px-1">
        <ul className="flex gap-1.5 whitespace-nowrap">
          <li>
            <Link
              href={keep({ status: "cancellation_requested", page: null })}
              aria-current={showingRequests ? "true" : undefined}
              className="admin-chip"
            >
              Cancellation requested
              {requests.length > 0 ? (
                <span className="ml-1 inline-flex min-w-5 justify-center rounded-full bg-stamp-red-text px-1 text-[0.6875rem] font-bold text-paper">
                  {requests.length}
                </span>
              ) : null}
            </Link>
          </li>
          {[{ value: "all", label: "All" }, ...ORDER_STATUSES.map((value) => ({ value, label: ORDER_STATUS_LABELS[value] ?? value }))].map((filter) => (
            <li key={filter.value}>
              <Link
                href={keep({ status: filter.value, page: null })}
                aria-current={status === filter.value ? "true" : undefined}
                className="admin-chip"
              >
                {filter.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {!showingRequests ? (
        <form method="get" className="admin-card flex flex-wrap items-end gap-3 p-3" role="search">
          {validStatus ? <input type="hidden" name="status" value={validStatus} /> : null}
          <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1 text-[0.75rem] font-medium text-ink/70">
            Search
            <input name="q" defaultValue={q} placeholder="Order number, name, email or phone" className="admin-input" />
          </label>
          <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-ink/70">
            From
            <input type="date" name="from" defaultValue={fromDay} className="admin-input" />
          </label>
          <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-ink/70">
            To
            <input type="date" name="to" defaultValue={toDay} className="admin-input" />
          </label>
          <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-ink/70">
            Sort
            <select name="sort" defaultValue={sort} className="admin-input">
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="min-h-9 rounded-control bg-blue-600 px-4 text-meta font-semibold text-paper hover:bg-blue-500">
            Apply
          </button>
          {filtered ? (
            <Link href="/admin/orders" className="min-h-9 content-center text-meta text-blue-600 hover:underline">
              Clear
            </Link>
          ) : null}
        </form>
      ) : null}

      {showingRequests ? (
        requests.length === 0 ? (
          <div className="admin-card">
            <p className="text-meta text-ink">Nobody is waiting on a cancellation.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {requests.map((request) => (
              <li key={request.id} className="admin-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/admin/orders/${request.id}`} className="font-semibold tabular-nums text-blue-600 hover:underline">
                      {request.orderNumber}
                    </Link>
                    <p className="mt-0.5 text-meta text-ink/70">
                      Asked {request.requestedAt ? formatShortDate(request.requestedAt) : "—"} · currently{" "}
                      {ORDER_STATUS_LABELS[request.status] ?? request.status}
                    </p>
                  </div>
                  <p className="font-semibold tabular-nums text-ink">{formatBdt(request.totalBdt)}</p>
                </div>
                <p className="mt-2 max-w-[70ch] border-l-2 border-brass pl-3 text-meta text-ink/80">
                  {request.reason?.trim() ? request.reason : "No reason given."}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : result && result.orders.length === 0 ? (
        <div className="admin-card">
          <p className="text-meta text-ink">{filtered ? "No orders match those filters." : "No orders yet."}</p>
        </div>
      ) : result ? (
        <div className="admin-card relative overflow-x-auto p-0">
          <table className="admin-table min-w-[900px]">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Customer</th>
                <th scope="col">Items</th>
                <th scope="col">Status</th>
                <th scope="col">Payment</th>
                <th scope="col" className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {result.orders.map((order) => (
                <tr key={order.id}>
                  <td className="whitespace-nowrap">
                    <Link href={`/admin/orders/${order.id}`} className="font-semibold tabular-nums text-blue-600 hover:underline">
                      {order.orderNumber}
                    </Link>
                    <span className="block text-ink/70">{formatShortDate(order.placedAt)}</span>
                  </td>
                  <td className="max-w-[16rem]">
                    <span className="block truncate text-ink">
                      {order.customerName ?? order.customerEmail ?? "—"}
                    </span>
                    <span className="block truncate text-ink/70">
                      {order.isGuest ? "Guest checkout" : order.customerName ? order.customerEmail : "Account"}
                    </span>
                  </td>
                  <td className="max-w-[18rem]">
                    <span className="block truncate text-ink">{order.firstTitle ?? "—"}</span>
                    <span className="block text-ink/70">
                      {order.itemCount} item{order.itemCount === 1 ? "" : "s"}
                      {order.lines > 1 ? ` · ${order.lines} products` : ""}
                      {order.hasPreorder ? " · preorder" : ""}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge tone={orderStatusTone(order.status)}>
                        {ORDER_STATUS_LABELS[order.status] ?? order.status}
                      </StatusBadge>
                      {order.cancellationRequestedAt && order.status !== "cancelled" && order.status !== "refunded" ? (
                        <span className="text-[0.6875rem] font-semibold text-stamp-red-text">Cancellation requested</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-ink/75">{paymentLabel(order)}</td>
                  <td className="text-right font-semibold tabular-nums">{formatBdt(order.totalBdt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {result && pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-3 text-meta">
          {page > 1 ? (
            <Link href={keep({ page: String(page - 1) })} className="text-blue-600 hover:underline">
              Previous
            </Link>
          ) : null}
          <span className="text-ink/70">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={keep({ page: String(page + 1) })} className="text-blue-600 hover:underline">
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
