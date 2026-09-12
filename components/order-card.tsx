import Link from "next/link";
import { IconArrowRight } from "@/components/icons";
import { StatusBadge } from "@/components/status-badge";
import { formatDate } from "@/lib/format";
import { formatBdt } from "@/lib/money";

/**
 * One order, as a shopper recognises it (DECISIONS.md D-043).
 *
 * The photograph, the product and the exact version bought come from the
 * snapshot taken when the order was placed, so this row keeps saying what was
 * bought after the listing behind it changes. Orders placed before that
 * snapshot existed carry no variant and no photograph, and the row simply
 * leaves them out rather than inventing either.
 *
 * Shared by the account dashboard and the orders list, so the two cannot
 * describe the same order differently.
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
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

export function orderStatusTone(
  status: string,
): "positive" | "negative" | "preorder" {
  if (status === "delivered") return "positive";
  if (status === "cancelled" || status === "refunded") return "negative";
  return "preorder";
}

export type OrderCardItem = {
  titleSnapshot: string;
  optionSummarySnapshot: string | null;
  imageUrlSnapshot: string | null;
  quantity: number;
};

export type OrderCardOrder = {
  id: string;
  orderNumber: string;
  status: string;
  totalBdt: number;
  placedAt: Date;
  items: OrderCardItem[];
};

export function OrderCard({ order }: { order: OrderCardOrder }) {
  const first = order.items[0] ?? null;
  const extra = Math.max(0, order.items.length - 1);

  return (
    <Link
      href={`/account/orders/${order.id}`}
      className="lift group flex flex-col gap-3 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)] sm:flex-row sm:items-center sm:gap-4 sm:p-5"
    >
      {first?.imageUrlSnapshot ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={first.imageUrlSnapshot}
          alt=""
          loading="lazy"
          className="size-14 shrink-0 rounded-card border border-blue-200 object-cover sm:size-16"
        />
      ) : null}

      <div className="min-w-0 flex-1">
        {first ? (
          <p className="truncate text-body font-medium text-ink">
            {first.titleSnapshot}
            {extra > 0 ? (
              <span className="text-ink/60"> and {extra} more</span>
            ) : null}
          </p>
        ) : null}

        {first?.optionSummarySnapshot ? (
          <p className="truncate text-meta text-ink/70">
            {first.optionSummarySnapshot}
          </p>
        ) : null}

        <p className="mt-0.5 text-meta tabular-nums text-ink/60">
          {order.orderNumber} · {formatDate(order.placedAt)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 sm:justify-end">
        <StatusBadge tone={orderStatusTone(order.status)}>
          {ORDER_STATUS_LABELS[order.status] ?? order.status}
        </StatusBadge>

        <span className="font-display text-price font-semibold tabular-nums text-ink">
          {formatBdt(order.totalBdt)}
        </span>

        <span className="ml-auto inline-flex items-center gap-1 text-meta font-medium text-blue-600 sm:ml-0">
          View order
          <IconArrowRight
            size={16}
            className="transition-transform duration-200 ease-[var(--ease-out-quint)] group-hover:translate-x-1"
          />
        </span>
      </div>
    </Link>
  );
}
