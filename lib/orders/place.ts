import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  addresses,
  cartItems,
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  productVariants,
  products,
} from "@/db/schema";
import {
  deliverQueuedNotificationsInBackground,
  queueOrderNotification,
} from "@/lib/notifications";
import { getSettings } from "@/lib/admin/settings";
import { splitLandedOrder } from "@/lib/pricing";
import { reserveCapacity } from "@/lib/preorder";
import {
  getPaymentProvider,
  type PaymentMethod,
} from "@/lib/providers/payment";

/**
 * Order placement.
 *
 * Everything here happens in one transaction: prices are re-read from the
 * database, capacity is reserved under a row lock, and the order is written.
 * If any part fails, no slot stays held and no order exists
 * (docs/BUSINESS_LOGIC.md).
 */

export class CheckoutError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

export type PlaceOrderInput = {
  cartId: string;
  userId: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  shippingAddressId: string;
  method: PaymentMethod;
  /** Supplied by the client so a retry cannot create a second order. */
  idempotencyKey: string;
};

export type PlacedOrder = {
  orderId: string;
  orderNumber: string;
  totalBdt: number;
  amountDueNowBdt: number;
  redirectUrl: string | null;
  /** True when an existing order was returned rather than a new one created. */
  reused: boolean;
};

/**
 * Human-facing order number: the year it was placed, then a zero-padded
 * sequence.
 *
 * Allocated from a Postgres sequence rather than by counting the orders
 * already placed. The count was a read-then-write race against a unique
 * column: two checkouts in the same instant read the same number, both tried
 * to insert it, and one customer got "Something went wrong" at the moment they
 * pressed Place order. It surfaced when several end-to-end tests started
 * checking out in parallel, and it would have surfaced in production the first
 * time two people ordered at once.
 *
 * `nextval` is atomic and takes no transaction-scoped lock, so concurrent
 * checkouts do not queue behind each other. A counter row incremented with an
 * upsert would also be correct, and was tried first — but it holds a row lock
 * for the rest of the transaction, which serialised every placement and cost
 * the end-to-end suite four minutes.
 *
 * Two consequences, both deliberate. The sequence does not restart each year,
 * so numbering runs continuously and the year is a label rather than a
 * counter — restarting it would need exactly the lock this avoids. And a
 * rolled-back placement leaves a gap, because a sequence does not roll back;
 * a number nobody was ever given is not a problem worth a lock.
 */
async function nextOrderNumber(tx: typeof db): Promise<string> {
  const year = new Date().getUTCFullYear();

  // postgres-js returns an array of rows; PGlite returns { rows }. The rest of
  // this file uses the query builder, which hides the difference — a raw
  // `nextval` cannot.
  const result = (await tx.execute(
    sql`select nextval('order_number_seq') as value`,
  )) as unknown as
    | { value: string | number }[]
    | { rows: { value: string | number }[] };

  const first = Array.isArray(result) ? result[0] : result.rows?.[0];
  const value = Number(first?.value ?? 0);

  return `ORD-${year}-${String(value).padStart(6, "0")}`;
}

/**
 * Cash on delivery is only offered on in-stock orders. A preorder funds the US
 * purchase, so it has to be paid before the item is bought
 * (MASTER_PRODUCT_SPEC.md §5.5).
 */
export function codAllowed(lines: { fulfillmentMode: string }[]): boolean {
  return lines.every((line) => line.fulfillmentMode === "in_stock");
}

export async function placeOrder(
  input: PlaceOrderInput,
): Promise<PlacedOrder> {
  // An existing order for this key is returned as-is: a retry after a timeout
  // or a double tap must not charge twice.
  const [alreadyPlaced] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      totalBdt: orders.totalBdt,
      amountDueNowBdt: orders.amountDueNowBdt,
    })
    .from(orders)
    .where(eq(orders.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (alreadyPlaced) {
    return {
      orderId: alreadyPlaced.id,
      orderNumber: alreadyPlaced.orderNumber,
      totalBdt: alreadyPlaced.totalBdt,
      amountDueNowBdt: alreadyPlaced.amountDueNowBdt,
      redirectUrl: null,
      reused: true,
    };
  }

  const [address] = await db
    .select({ id: addresses.id, userId: addresses.userId })
    .from(addresses)
    .where(eq(addresses.id, input.shippingAddressId))
    .limit(1);

  if (!address) throw new CheckoutError("Choose a delivery address.");

  // An address belongs to the account that created it.
  if (input.userId && address.userId !== input.userId) {
    throw new CheckoutError("That delivery address is not yours.");
  }

  // Read before the transaction opens: settings are configuration, and holding
  // a transaction open across an extra round trip buys nothing.
  const configured = await getSettings([
    "landed.shipping_per_kg_bdt",
    "landed.duty_percent",
    "landed.assumed_weight_grams",
  ]);

  const rates = {
    shippingPerKgBdt: configured["landed.shipping_per_kg_bdt"],
    dutyPercent: configured["landed.duty_percent"],
    assumedWeightGrams: configured["landed.assumed_weight_grams"],
  };

  const placed = await db.transaction(async (tx) => {
    const lines = await tx
      .select({
        itemId: cartItems.id,
        variantId: cartItems.variantId,
        quantity: cartItems.quantity,
        title: products.title,
        priceBdt: productVariants.priceBdt,
        fulfillmentMode: productVariants.fulfillmentMode,
        paymentMode: productVariants.paymentMode,
        depositPercent: productVariants.depositPercent,
        estimatedArrivalFrom: productVariants.estimatedArrivalFrom,
        weightGrams: productVariants.weightGrams,
      })
      .from(cartItems)
      .innerJoin(productVariants, eq(cartItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(cartItems.cartId, input.cartId));

    if (lines.length === 0) throw new CheckoutError("Your cart is empty.");

    if (input.method === "cod" && !codAllowed(lines)) {
      throw new CheckoutError(
        "Cash on delivery is not available for preorders — they fund the purchase in the US.",
      );
    }

    // Reserve every line before writing anything. Capacity is checked under a
    // row lock here, which is the authoritative check.
    for (const line of lines) {
      await reserveCapacity(tx, line.variantId, line.quantity);
    }

    // Prices come from the rows just read inside this transaction, never from
    // the client and never from the cart.
    const landedTotalBdt = lines.reduce(
      (sum, line) => sum + line.priceBdt * line.quantity,
      0,
    );

    // The landed price is what the shopper pays; this only records what it is
    // made of, so the total is unchanged by the split (lib/pricing/landed.ts).
    const breakdown = splitLandedOrder(
      lines.map((line) => ({
        unitPriceBdt: line.priceBdt,
        quantity: line.quantity,
        weightGrams: line.weightGrams,
      })),
      rates,
    );

    const amountDueNowBdt = lines.reduce((sum, line) => {
      const lineTotal = line.priceBdt * line.quantity;
      if (line.paymentMode === "deposit" && line.depositPercent) {
        return sum + Math.round((lineTotal * line.depositPercent) / 100);
      }
      return sum + lineTotal;
    }, 0);

    const orderNumber = await nextOrderNumber(tx as unknown as typeof db);

    const [order] = await tx
      .insert(orders)
      .values({
        orderNumber,
        userId: input.userId,
        guestEmail: input.guestEmail,
        guestPhone: input.guestPhone,
        status: "placed",
        shippingAddressId: input.shippingAddressId,
        // The three parts add back to exactly the landed total, so what the
        // shopper pays is the same as it was before the split existed.
        subtotalBdt: breakdown.goodsBdt,
        shippingFeeBdt: breakdown.shippingBdt,
        dutyBdt: breakdown.dutyBdt,
        discountBdt: 0,
        totalBdt: landedTotalBdt,
        amountDueNowBdt,
        idempotencyKey: input.idempotencyKey,
      })
      .returning({
        id: orders.id,
        orderNumber: orders.orderNumber,
        totalBdt: orders.totalBdt,
        amountDueNowBdt: orders.amountDueNowBdt,
      });

    await tx.insert(orderItems).values(
      lines.map((line) => ({
        orderId: order.id,
        variantId: line.variantId,
        titleSnapshot: line.title,
        unitPriceBdt: line.priceBdt,
        quantity: line.quantity,
        fulfillmentModeSnapshot: line.fulfillmentMode,
        estimatedArrivalSnapshot: line.estimatedArrivalFrom,
      })),
    );

    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      status: "placed",
      note: "Order placed by the shopper.",
      actorUserId: input.userId,
    });

    // The cart is emptied inside the same transaction, so a failure cannot
    // leave the shopper with both an order and the items still in their cart.
    await tx.delete(cartItems).where(eq(cartItems.cartId, input.cartId));

    // Queued in the same transaction as the order: a message exists only for
    // an order that was actually committed (lib/notifications).
    await queueOrderNotification(tx, order.id, "placed");

    return order;
  });

  // The payment attempt is made after the order exists, so there is always
  // something to attach it to.
  const provider = getPaymentProvider();
  const intent = await provider.createPayment({
    orderId: placed.id,
    orderNumber: placed.orderNumber,
    amountBdt: placed.amountDueNowBdt,
    method: input.method,
    customerEmail: input.guestEmail ?? "",
    idempotencyKey: input.idempotencyKey,
  });

  await db.insert(payments).values({
    orderId: placed.id,
    kind: "full",
    provider: provider.name,
    providerRef: intent.providerRef,
    method: input.method,
    amountBdt: placed.amountDueNowBdt,
    status: intent.status === "failed" ? "failed" : "initiated",
  });

  // Delivery is outside the transaction and cannot fail the order.
  deliverQueuedNotificationsInBackground();

  return {
    orderId: placed.id,
    orderNumber: placed.orderNumber,
    totalBdt: placed.totalBdt,
    amountDueNowBdt: placed.amountDueNowBdt,
    redirectUrl: intent.redirectUrl,
    reused: false,
  };
}
