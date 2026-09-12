import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LinkButton } from "@/components/button";
import { AccountNav } from "@/components/account-nav";
import { EmptyState } from "@/components/empty-state";
import { IconArrowRight, IconManifest, IconStar } from "@/components/icons";
import { OrderCard } from "@/components/order-card";
import { Panel } from "@/components/panel";
import { getCurrentUser } from "@/lib/auth";
import { countWishlist } from "@/lib/account";
import { listOrderSummariesForUser } from "@/lib/orders";
import { listReviewableProducts } from "@/lib/reviews";
import { formatBdt } from "@/lib/money";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false },
};

/** Statuses that mean the order is still on its way. */
const IN_FLIGHT = new Set([
  "placed",
  "payment_confirmed",
  "sourcing",
  "shipped_from_us",
  "in_bd_customs",
  "out_for_delivery",
]);

/**
 * The account dashboard (DECISIONS.md D-043).
 *
 * One place for the whole account: what is happening right now, the most
 * recent orders with the exact version bought, and the way through to
 * everything else. "My account" and "My orders" used to be two destinations
 * for the same thing; orders now live inside the account.
 *
 * Every figure here is counted from the shopper's own orders — nothing on this
 * page is illustrative.
 */
export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account");

  const [orders, reviewable, savedCount] = await Promise.all([
    listOrderSummariesForUser(user.id),
    listReviewableProducts(user),
    countWishlist(user.id),
  ]);

  const processing = orders.filter((order) => IN_FLIGHT.has(order.status));
  const delivered = orders.filter((order) => order.status === "delivered");
  const spent = orders
    .filter((order) => order.status !== "cancelled" && order.status !== "refunded")
    .reduce((total, order) => total + order.totalBdt, 0);

  const firstName = user.firstName?.trim().split(/\s+/)[0] ?? null;

  const stats = [
    { label: "Orders", value: String(orders.length), href: "/account/orders" },
    {
      label: "On the way",
      value: String(processing.length),
      href: "/account/orders",
    },
    { label: "Delivered", value: String(delivered.length), href: "/account/orders" },
    { label: "Saved", value: String(savedCount), href: "/account/wishlist" },
  ];

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-10 md:px-6 md:py-12">
      {/* A greeting, not a page title with a subtitle under it. */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-meta uppercase tracking-[0.18em] text-brass-text">
            Your account
          </p>
          <h1 className="mt-1 font-display text-[clamp(1.625rem,4vw,2.25rem)] leading-tight text-ink">
            {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          </h1>
          <p className="mt-1 text-meta text-ink/70">
            {processing.length > 0
              ? `${processing.length} order${processing.length === 1 ? "" : "s"} on the way.`
              : "Nothing is on its way right now."}{" "}
            Signed in as {user.email}.
          </p>
        </div>

        <LinkButton href="/search?available=1" variant="secondary" size="sm">
          Keep shopping
        </LinkButton>
      </header>

      <AccountNav current="/account" />

      {/* Four figures, each a link to where they can be acted on — counted
          from this account's own orders, never illustrative. */}
      <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((stat) => (
          <li key={stat.label}>
            <Link
              href={stat.href}
              className="lift flex h-full flex-col justify-between rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
            >
              <span className="text-meta text-ink/70">{stat.label}</span>
              <span className="mt-2 font-display text-h2 tabular-nums text-ink">
                {stat.value}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {orders.length > 0 ? (
        <p className="mt-3 text-meta text-ink/70">
          {formatBdt(spent)} spent with us so far.
        </p>
      ) : null}

      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-h2 text-ink">Recent orders</h2>
          {orders.length > 3 ? (
            <Link
              href="/account/orders"
              className="inline-flex items-center gap-1 text-meta font-medium text-blue-600 underline-offset-4 hover:underline"
            >
              All {orders.length} orders
              <IconArrowRight size={16} />
            </Link>
          ) : null}
        </div>

        {orders.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={<IconManifest size={26} />}
            title="You have not ordered yet"
            body="When you preorder something, it appears here with its whole journey — from the batch closing to the courier reaching your door."
            action={{ href: "/search?available=1", label: "See what is open" }}
            secondary={{ href: "/orders/lookup", label: "Look up an order" }}
          />
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {orders.slice(0, 3).map((order) => (
              <li key={order.id}>
                <OrderCard order={order} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {reviewable.length > 0 ? (
        <section className="mt-12">
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
