import { formatBdt } from "@/lib/money";

/**
 * What each order event says to the customer.
 *
 * Plain text, written for someone who is waiting on a parcel from another
 * country: what happened, what it means for their money, and what happens
 * next. Nothing here reads internal notes, supplier costs, or margins — the
 * caller only ever passes the fields below (CLAUDE.md section 7).
 */

export const NOTIFIED_STATUSES = [
  "placed",
  "payment_confirmed",
  "sourcing",
  "shipped_from_us",
  "in_bd_customs",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "refunded",
] as const;

export type NotifiedStatus = (typeof NOTIFIED_STATUSES)[number];

export function isNotifiedStatus(status: string): status is NotifiedStatus {
  return (NOTIFIED_STATUSES as readonly string[]).includes(status);
}

export type OrderNotificationFacts = {
  orderNumber: string;
  totalBdt: number;
  amountDueNowBdt: number;
};

export type ComposedMessage = { subject: string; body: string };

function money(paisa: number): string {
  return formatBdt(paisa);
}

export function composeOrderMessage(
  status: NotifiedStatus,
  facts: OrderNotificationFacts,
): ComposedMessage {
  const { orderNumber } = facts;

  switch (status) {
    case "placed":
      return {
        subject: `Order ${orderNumber} received`,
        body: [
          `We have your order ${orderNumber}.`,
          `Paid now: ${money(facts.amountDueNowBdt)}. Order total: ${money(facts.totalBdt)}.`,
          "Nothing is bought in the US until your payment is confirmed. We will write again when it is.",
        ].join("\n\n"),
      };

    case "payment_confirmed":
      return {
        subject: `Payment confirmed for ${orderNumber}`,
        body: [
          `Your payment for ${orderNumber} is confirmed and your place in this batch is held.`,
          "Next we buy the item in the US. You can cancel for a full refund until that happens.",
        ].join("\n\n"),
      };

    case "sourcing":
      return {
        subject: `We are buying your items for ${orderNumber}`,
        body: [
          `Your items for ${orderNumber} are being bought in the US now.`,
          "From this point the order can no longer be cancelled for an automatic refund, because the goods have been purchased.",
        ].join("\n\n"),
      };

    case "shipped_from_us":
      return {
        subject: `${orderNumber} has left the US`,
        body: [
          `Your order ${orderNumber} has shipped from the US and is on its way to Bangladesh.`,
          "Customs clearance is the next step, and it is the least predictable one. We will tell you when it is through.",
        ].join("\n\n"),
      };

    case "in_bd_customs":
      return {
        subject: `${orderNumber} is in customs in Bangladesh`,
        body: [
          `Your order ${orderNumber} has arrived in Bangladesh and is with customs.`,
          "Duty is already included in the price you paid. There is nothing for you to pay on delivery.",
        ].join("\n\n"),
      };

    case "out_for_delivery":
      return {
        subject: `${orderNumber} is out for delivery`,
        body: [
          `Your order ${orderNumber} is with the courier and out for delivery.`,
          "Please keep your phone reachable so the courier can find you.",
        ].join("\n\n"),
      };

    case "delivered":
      return {
        subject: `${orderNumber} delivered`,
        body: [
          `Your order ${orderNumber} has been delivered. Thank you for waiting through the import.`,
          "If anything is wrong with what arrived, reply to this message and we will sort it out.",
        ].join("\n\n"),
      };

    case "cancelled":
      return {
        subject: `${orderNumber} cancelled`,
        body: [
          `Your order ${orderNumber} has been cancelled and its place in the batch has been released.`,
          "Any amount already paid is refunded to the method you paid with.",
        ].join("\n\n"),
      };

    case "refunded":
      return {
        subject: `${orderNumber} refunded`,
        body: [
          `A refund for ${orderNumber} has been issued to the method you paid with.`,
          "Your bank decides how long it takes to appear, which is usually a few working days.",
        ].join("\n\n"),
      };
  }
}

export type WaitlistNotificationFacts = {
  productTitle: string;
  variantLabel: string;
  productSlug: string;
  /** How many places opened up. Stated plainly, because it sets expectations. */
  places: number;
};

/**
 * What someone on the waitlist is told when places open up again.
 *
 * The message is deliberate about what it is *not* promising. No place is held
 * for them — see DECISIONS.md D-011 — so it says so, rather than letting
 * someone read "a place is available" as "a place is yours" and find it gone
 * an hour later. That would be worse than not writing at all.
 */
export function composeWaitlistMessage(
  facts: WaitlistNotificationFacts,
): ComposedMessage {
  const what =
    facts.variantLabel && facts.variantLabel !== "Single variant"
      ? `${facts.productTitle} (${facts.variantLabel})`
      : facts.productTitle;

  return {
    subject: `${what} is available again`,
    body: [
      `A place has opened up in the batch for ${what}.`,
      facts.places === 1
        ? "There is one place, and it is not held for you — whoever orders first takes it."
        : `There are ${facts.places} places, and none is held for you — they go to whoever orders first.`,
      "If you still want it, order now while the window is open.",
    ].join("\n\n"),
  };
}

export type BalanceNotificationFacts = {
  orderNumber: string;
  amountBdt: number;
  totalBdt: number;
};

/**
 * What a customer is told when the balance on a deposit order is taken.
 *
 * Staff decide when this happens (DECISIONS.md D-012), so the message has to
 * say what was charged and against which order — a payment the customer did
 * not initiate is exactly the kind that needs explaining, not announcing.
 */
export function composeBalanceMessage(
  facts: BalanceNotificationFacts,
): ComposedMessage {
  return {
    subject: `Balance received for order ${facts.orderNumber}`,
    body: [
      `We have taken the remaining ${money(facts.amountBdt)} on order ${facts.orderNumber}.`,
      `That settles it in full: ${money(facts.totalBdt)}, with shipping and customs duty already inside the price.`,
      "Nothing further is due, and nothing is owed to the courier on delivery.",
    ].join("\n\n"),
  };
}

export type PartialRefundFacts = {
  orderNumber: string;
  amountBdt: number;
  /** What the order still comes to after this refund. */
  remainingTotalBdt: number;
};

/**
 * What a customer is told when part of an order is refunded.
 *
 * Deliberately not the `refunded` order message. That one says the order is
 * over, and a partial refund is the opposite: a price correction or a goodwill
 * payment on an order that is still coming. Telling someone their order was
 * refunded when it is still on its way would be worse than saying nothing.
 */
export function composePartialRefundMessage(
  facts: PartialRefundFacts,
): ComposedMessage {
  return {
    subject: `${money(facts.amountBdt)} refunded on order ${facts.orderNumber}`,
    body: [
      `We have refunded ${money(facts.amountBdt)} against order ${facts.orderNumber}.`,
      `The order itself is unchanged and still on its way. What you have paid for it now stands at ${money(facts.remainingTotalBdt)}.`,
      "The refund reaches the account you paid from, on that provider's own timescale.",
    ].join("\n\n"),
  };
}
