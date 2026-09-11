import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LinkButton } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { IconArrowRight, IconManifest, IconStar } from "@/components/icons";
import { AccountNav } from "@/components/account-nav";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
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

  const inFlight = orders.filter(
    (order) =>
      order.status !== "delivered" &&
      order.status !== "cancelled" &&
      order.status !== "refunded",
  ).length;

  return (
    <div className="mx-auto w-full max-w-[960px] px-4 py-10 md:px-6 md:py-12">
      <PageHeading
        eyebrow="Your account"
        title="Your orders"
        summary={
          orders.length === 0
            ? "Everything you order will be tracked here."
            : `${orders.length} order${orders.length === 1 ? "" : "s"}${
                inFlight > 0 ? `, ${inFlight} still on the way` : ""
              }.`
        }
        aside={
          <LinkButton href="/account/security" variant="secondary" size="sm">
            Security
          </LinkButton>
        }
      />

      <p className="mt-3 text-meta text-ink/70">Signed in as {user.email}</p>

      <AccountNav current="/account" />

      {orders.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon={<IconManifest size={26} />}
          title="You have not ordered yet"
          body="When you preorder something, it appears here with its whole journey — from the batch closing to the courier reaching your door."
          action={{ href: "/search?available=1", label: "See what is open" }}
          secondary={{ href: "/orders/lookup", label: "Look up an order" }}
        />
      ) : (
        <ul className="mt-8 flex flex-col gap-3">
          {orders.map((order) => (
            <li key={order.id}>
              {/*
               * The whole row is the link. It was a small blue order number
               * inside a bare bordered row before, which made the largest
               * target on the screen — the row — do nothing at all.
               */}
              <Link
                href={`/account/orders/${order.id}`}
                className="lift group flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)] sm:p-5"
              >
                <div className="min-w-0">
                  <p className="font-display text-h3 tabular-nums text-ink">
                    {order.orderNumber}
                  </p>
                  <p className="text-meta text-ink/70">
                    Placed {formatDate(order.placedAt)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-4">
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

                  <span className="font-display text-price font-semibold tabular-nums text-ink">
                    {formatBdt(order.totalBdt)}
                  </span>

                  <IconArrowRight
                    size={18}
                    className="text-blue-500 transition-transform duration-200 ease-[var(--ease-out-quint)] group-hover:translate-x-1"
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {reviewable.length > 0 ? (
        <section className="mt-14">
          <div className="flex items-baseline gap-3">
            <IconStar size={20} className="shrink-0 text-brass" />
            <h2 className="font-display text-h2 text-ink">
              Products you can review
            </h2>
          </div>
          <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
            You are asked only about things that reached you. A review appears
            on the product page once someone here has read it.
          </p>

          <Panel className="mt-5 overflow-hidden">
            <ul>
              {reviewable.map((product) => (
                <li
                  key={product.productId}
                  className="flex flex-wrap items-center justify-between gap-4 border-b border-blue-200 px-5 py-4 last:border-b-0"
                >
                  <p className="text-body text-ink">{product.title}</p>
                  <LinkButton
                    href={`/products/${product.slug}#reviews`}
                    variant="secondary"
                    size="sm"
                  >
                    Write a review
                  </LinkButton>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}
    </div>
  );
}
