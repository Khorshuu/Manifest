/** One vocabulary for order states across the admin's lists and dashboard. */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  placed: "Awaiting payment",
  payment_confirmed: "Paid",
  sourcing: "Sourcing",
  shipped_from_us: "Shipped from US",
  in_bd_customs: "In customs",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

export function orderStatusTone(status: string) {
  if (status === "delivered") return "positive" as const;
  if (status === "cancelled" || status === "refunded") return "negative" as const;
  if (status === "placed") return "warning" as const;
  return "preorder" as const;
}

/**
 * How much of an order has been paid, in words. Derived from the status and
 * the amount taken at placement — the payment rows on the order page are the
 * authority when a balance has since been collected.
 */
export function paymentLabel(order: {
  status: string;
  totalBdt: number;
  amountDueNowBdt: number;
}): string {
  if (order.status === "placed") return "Unpaid";
  if (order.status === "refunded") return "Refunded";
  if (order.status === "cancelled") return "—";
  return order.amountDueNowBdt < order.totalBdt ? "Deposit paid" : "Paid in full";
}
