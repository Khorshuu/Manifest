import type { Metadata } from "next";
import Link from "next/link";
import { listCustomersWithOrders } from "@/lib/admin";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { formatShortDate } from "@/lib/format";
import { formatBdt } from "@/lib/money";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Customers" };

const PAGE_SIZE = 50;

export default async function AdminCustomersPage({
  searchParams,
}: PageProps<"/admin/customers">) {
  // The layout hides the link; this is the page's own check, and
  // listCustomersWithOrders checks the same permission again.
  const user = await requireAdminPage("customers.view");

  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.slice(0, 120) : "";
  const page = Math.max(1, Number(params.page) || 1);

  const { customers, total } = await listCustomersWithOrders(user, {
    query,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (next: number) =>
    `/admin/customers?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(next) })}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="admin-h1">Customers</h1>
          <p className="mt-1 text-meta text-ink/70">
            {total} account{total === 1 ? "" : "s"}
            {query ? ` matching “${query}”` : ""}. Spent is the total of paid
            orders that were not cancelled or refunded.
          </p>
        </div>

        <form method="get" className="flex items-center gap-2" role="search">
          <label htmlFor="customer-q" className="sr-only">
            Search customers
          </label>
          <input
            id="customer-q"
            name="q"
            defaultValue={query}
            placeholder="Name, email or phone"
            className="admin-input w-64 max-w-full"
          />
          <button type="submit" className="admin-chip">
            Search
          </button>
          {query ? (
            <Link href="/admin/customers" className="text-meta text-blue-600 hover:underline">
              Clear
            </Link>
          ) : null}
        </form>
      </div>

      {customers.length === 0 ? (
        <div className="admin-card">
          <p className="text-meta text-ink">
            {query ? "No customer matches that search." : "No customer accounts yet."}
          </p>
        </div>
      ) : (
        <div className="admin-card relative overflow-x-auto p-0">
          <table className="admin-table min-w-[720px]">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Phone</th>
                <th scope="col">Joined</th>
                <th scope="col" className="text-right">Paid orders</th>
                <th scope="col" className="text-right">Spent</th>
                <th scope="col">Last order</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => {
                const name = [customer.firstName, customer.lastName]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr key={customer.id}>
                    <td>
                      <span className="block font-medium text-ink">{name || customer.email}</span>
                      {name ? <span className="block text-ink/70">{customer.email}</span> : null}
                    </td>
                    <td className="text-ink/70">{customer.phone ?? "—"}</td>
                    <td className="text-ink/70">{formatShortDate(customer.createdAt)}</td>
                    <td className="text-right tabular-nums">
                      {customer.paidCount}
                      {customer.orderCount > customer.paidCount ? (
                        <span className="ml-1 text-ink/70" title="Orders not paid, cancelled or refunded">
                          (+{customer.orderCount - customer.paidCount})
                        </span>
                      ) : null}
                    </td>
                    <td className="text-right font-semibold tabular-nums">
                      {formatBdt(customer.spentBdt)}
                    </td>
                    <td className="text-ink/70">
                      {customer.lastOrderAt ? formatShortDate(customer.lastOrderAt) : "Never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-3 text-meta">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="text-blue-600 hover:underline">
              Previous
            </Link>
          ) : null}
          <span className="text-ink/70">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={pageHref(page + 1)} className="text-blue-600 hover:underline">
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
