import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { getCurrentUser } from "@/lib/auth";
import { listOrdersForUser } from "@/lib/orders";
import { listReviewableProducts } from "@/lib/reviews";
import { formatBdt } from "@/lib/money";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false },
};

const STATUS_LABELS: Record<string, string> = {
  placed: "Awaiting payment",
  payment_confirmed: "Payment confirmed",
  sourcing: "Sourcing in the US",
  shipped_from_us: "Shipped from the US",
  in_bd_customs: "In customs",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account");

  const [orders, reviewable] = await Promise.all([
    listOrdersForUser(user.id),
    listReviewableProducts(user),
  ]);

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-8 md:px-6">
      <h1 className="font-display text-h1 text-ink">Your orders</h1>
      <p className="mt-2 text-meta text-ink/70">Signed in as {user.email}</p>

      {orders.length === 0 ? (
        <div className="mt-8 border border-blue-300 p-8">
          <p className="text-body text-ink">You have not ordered yet.</p>
          <Link
            href="/"
            className="mt-4 inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
          >
            Browse products
          </Link>
        </div>
      ) : (
        <ul className="mt-8 border-t border-blue-300">
          {orders.map((order) => (
            <li
              key={order.id}
              className="flex flex-wrap items-center justify-between gap-4 border-b border-blue-300 py-4"
            >
              <div>
                <Link
                  href={`/account/orders/${order.id}`}
                  className="font-display text-h3 tabular-nums text-blue-600 hover:underline"
                >
                  {order.orderNumber}
                </Link>
                <p className="text-meta text-ink/70">
                  Placed {formatDate(order.placedAt)}
                </p>
              </div>

              <div className="flex items-center gap-4">
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
                  {STATUS_LABELS[order.status] ?? order.status}
                </StatusBadge>
                <span className="tabular-nums text-body text-ink">
                  {formatBdt(order.totalBdt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {reviewable.length > 0 ? (
        <section className="mt-12">
          <h2 className="font-display text-h2 text-ink">
            Products you can review
          </h2>
          <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
            You are asked only about things that reached you. A review appears
            on the product page once someone here has read it.
          </p>
          <ul className="mt-4 border-t border-blue-300">
            {reviewable.map((product) => (
              <li
                key={product.productId}
                className="flex flex-wrap items-center justify-between gap-4 border-b border-blue-300 py-4"
              >
                <p className="text-body text-ink">{product.title}</p>
                <Link
                  href={`/products/${product.slug}#reviews`}
                  className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
                >
                  Write a review
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
