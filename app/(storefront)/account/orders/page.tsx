import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountNav } from "@/components/account-nav";
import { EmptyState } from "@/components/empty-state";
import { IconManifest } from "@/components/icons";
import { OrderCard, ORDER_STATUS_LABELS } from "@/components/order-card";
import { PageHeading } from "@/components/page-heading";
import { getCurrentUser } from "@/lib/auth";
import { listOrderSummariesForUser } from "@/lib/orders";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your orders",
  robots: { index: false },
};

/**
 * Every order this account has placed, inside the account rather than beside
 * it (DECISIONS.md D-043). The dashboard shows the three most recent; this is
 * the same rows, filtered by status.
 */
export default async function AccountOrdersPage({
  searchParams,
}: PageProps<"/account/orders">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/orders");

  const params = await searchParams;
  const requested = typeof params.status === "string" ? params.status : "";
  const status = ORDER_STATUS_LABELS[requested] ? requested : "";

  const orders = await listOrderSummariesForUser(user.id);
  const shown = status
    ? orders.filter((order) => order.status === status)
    : orders;

  // Only the statuses this account actually has, in the order they happen —
  // a filter for something nobody has ordered is a dead end.
  const present = Object.keys(ORDER_STATUS_LABELS).filter((key) =>
    orders.some((order) => order.status === key),
  );

  const chip = (active: boolean) =>
    `inline-flex min-h-11 items-center rounded-control border px-3 text-meta transition-colors ${
      active
        ? "border-blue-600 bg-blue-50 font-medium text-blue-600"
        : "border-blue-300 text-ink hover:border-blue-500 hover:bg-blue-50"
    }`;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-10 md:px-6 md:py-12">
      <PageHeading
        eyebrow="Your account"
        title="Your orders"
        summary={
          orders.length === 0
            ? "Everything you order will be tracked here."
            : `${orders.length} order${orders.length === 1 ? "" : "s"}, newest first. Each one keeps the exact version you bought.`
        }
      />

      <AccountNav current="/account/orders" />

      {present.length > 1 ? (
        <nav aria-label="Filter orders" className="-mx-4 mt-4 overflow-x-auto px-4">
          <ul className="flex gap-2">
            <li className="shrink-0">
              <Link href="/account/orders" className={chip(status === "")}>
                All
              </Link>
            </li>
            {present.map((key) => (
              <li key={key} className="shrink-0">
                <Link
                  href={`/account/orders?status=${key}`}
                  className={chip(status === key)}
                >
                  {ORDER_STATUS_LABELS[key]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon={<IconManifest size={26} />}
          title={status ? "Nothing with that status" : "You have not ordered yet"}
          body={
            status
              ? "Try another status, or see every order you have placed."
              : "When you preorder something, it appears here with its whole journey — from the batch closing to the courier reaching your door."
          }
          action={
            status
              ? { href: "/account/orders", label: "See all orders" }
              : { href: "/search?available=1", label: "See what is open" }
          }
          secondary={{ href: "/orders/lookup", label: "Look up an order" }}
        />
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {shown.map((order) => (
            <li key={order.id}>
              <OrderCard order={order} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
