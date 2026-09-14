import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { effectivePriceSql } from "@/lib/catalog/price";
import {
  loadVariantOptions,
  summariseOptions,
} from "@/lib/catalog/variant-options";
import {
  addresses,
  cartItems,
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  productVariants,
  products,
  variantImages,
} from "@/db/schema";
import {
  deliverQueuedNotificationsInBackground,
  queueOrderNotification,
} from "@/lib/notifications";
import { getSettings } from "@/lib/admin/settings";
import { splitLandedOrder } from "@/lib/pricing";
import { reserveCapacityForLines } from "@/lib/preorder";
import {
  getPaymentProvider,
  type PaymentMethod,
} from "@/lib/providers/payment";
import {
  isTransientDatabaseError,
  isUniqueViolation,
  withTransientRetry,
} from "@/lib/db-errors";
import { TransientConflictError } from "@/lib/errors";

/**
 * Order placement.
 *
 * Everything that decides the order happens in one transaction: prices are
 * re-read from the database, capacity is reserved under row locks taken in a
 * fixed order, and the order, its lines, its first history row and its
 * payment record are written. If any part fails, no slot stays held and no
 * order exists (docs/BUSINESS_LOGIC.md).
 *
 * The payment provider is called only after that transaction commits, so a
 * slow gateway never holds a lock on a variant another shopper is waiting for.
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
  /**
   * Whether the provider accepted the payment attempt. "failed" leaves a
   * placed, unpaid order that releases its places when the hold expires.
   */
  paymentStatus: "initiated" | "failed";
};

/**
 * Human-facing order number: the year it was placed, then a zero-padded
 * sequence.
 *
 * Allocated from a Postgres sequence rather than by counting the orders
 * already placed. The count was a read-then-write race against a unique
 * column: two checkouts in the same instant read the same number, both tried
 * to insert it, and one customer got "Something went wrong" at the moment they
 * pressed Place order.
 *
 * `nextval` is atomic and takes no transaction-scoped lock, so concurrent
 * checkouts do not queue behind each other. The sequence does not restart each
 * year, and a rolled-back placement leaves a gap; both are deliberate.
 */
async function nextOrderNumber(tx: typeof db): Promise<string> {
  const year = new Date().getUTCFullYear();

  // postgres-js returns an array of rows; PGlite returns { rows }.
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

const IDEMPOTENCY_CONSTRAINT = "orders_idempotency_key_unique";

async function findOrderByKey(executor: typeof db, idempotencyKey: string) {
  const [order] = await executor
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      totalBdt: orders.totalBdt,
      amountDueNowBdt: orders.amountDueNowBdt,
    })
    .from(orders)
    .where(eq(orders.idempotencyKey, idempotencyKey))
    .limit(1);
  return order ?? null;
}

function reusedResult(order: NonNullable<Awaited<ReturnType<typeof findOrderByKey>>>): PlacedOrder {
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    totalBdt: order.totalBdt,
    amountDueNowBdt: order.amountDueNowBdt,
    redirectUrl: null,
    reused: true,
    paymentStatus: "initiated",
  };
}

export async function placeOrder(
  input: PlaceOrderInput,
): Promise<PlacedOrder> {
  // Fast path for a retry that arrives after the first request finished. It is
  // an optimisation only: the authoritative check is inside the transaction.
  const alreadyPlaced = await findOrderByKey(db, input.idempotencyKey);
  if (alreadyPlaced) return reusedResult(alreadyPlaced);

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

  const provider = getPaymentProvider();

  const attempt = () =>
    db.transaction(async (tx) => {
      /*
       * One placement per key at a time. Two requests with the same key — a
       * double tap, a retry after a timeout — queue here, and the second finds
       * the order the first committed. Checking before inserting without this
       * lock is a race; relying on the unique constraint alone turned nine of
       * ten simultaneous submissions into server errors.
       */
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`,
      );

      const existing = await findOrderByKey(tx as unknown as typeof db, input.idempotencyKey);
      if (existing) return { kind: "reused" as const, order: existing };

      const lines = await tx
        .select({
          itemId: cartItems.id,
          variantId: cartItems.variantId,
          quantity: cartItems.quantity,
          title: products.title,
          sku: productVariants.sku,
          /* The charged price, read inside the transaction that places the
             order — a sale that ended a second ago is not honoured. */
          priceBdt: effectivePriceSql,
          fulfillmentMode: productVariants.fulfillmentMode,
          paymentMode: productVariants.paymentMode,
          depositPercent: productVariants.depositPercent,
          estimatedArrivalFrom: productVariants.estimatedArrivalFrom,
          weightGrams: productVariants.weightGrams,
        })
        .from(cartItems)
        .innerJoin(productVariants, eq(cartItems.variantId, productVariants.id))
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(cartItems.cartId, input.cartId))
        // The order the shopper added them in, so the order lines read the
        // same way the cart did. Locking does not depend on it.
        .orderBy(asc(cartItems.addedAt), asc(cartItems.id));

      if (lines.length === 0) throw new CheckoutError("Your cart is empty.");

      if (input.method === "cod" && !codAllowed(lines)) {
        throw new CheckoutError(
          "Cash on delivery is not available for preorders — they fund the purchase in the US.",
        );
      }

      // Every variant locked in one statement, in id order, and checked before
      // anything is written. This is the authoritative capacity check.
      await reserveCapacityForLines(
        tx,
        lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      );

      /*
       * What each line actually is, frozen here rather than re-read later. A
       * variant can be renamed, repriced, rephotographed or archived after the
       * order exists; the order has to keep saying what was bought (D-043).
       */
      const variantIds = lines.map((line) => line.variantId);
      const [optionsByVariant, variantPhotos] = await Promise.all([
        loadVariantOptions(variantIds, tx),
        tx
          .selectDistinctOn([variantImages.variantId], {
            variantId: variantImages.variantId,
            url: variantImages.url,
          })
          .from(variantImages)
          .where(inArray(variantImages.variantId, variantIds))
          .orderBy(variantImages.variantId, variantImages.sortOrder),
      ]);

      // Prices come from the rows just read inside this transaction, never
      // from the client and never from the cart.
      const landedTotalBdt = lines.reduce(
        (sum, line) => sum + line.priceBdt * line.quantity,
        0,
      );

      // The landed price is what the shopper pays; this only records what it
      // is made of, so the total is unchanged by the split.
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
          optionSummarySnapshot:
            summariseOptions(optionsByVariant.get(line.variantId) ?? []) || null,
          variantOptionsSnapshot: optionsByVariant.get(line.variantId) ?? [],
          skuSnapshot: line.sku,
          imageUrlSnapshot:
            variantPhotos.find((photo) => photo.variantId === line.variantId)
              ?.url ?? null,
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

      /*
       * The payment record exists from the moment the order does. Before, it
       * was written after the provider answered, so a provider that threw
       * left an order holding capacity with no trace of the attempt.
       */
      const [payment] = await tx
        .insert(payments)
        .values({
          orderId: order.id,
          kind: "full",
          provider: provider.name,
          providerRef: null,
          method: input.method,
          amountBdt: amountDueNowBdt,
          status: "initiated",
        })
        .returning({ id: payments.id });

      // The cart is emptied inside the same transaction, so a failure cannot
      // leave the shopper with both an order and the items still in the cart.
      await tx.delete(cartItems).where(eq(cartItems.cartId, input.cartId));

      // Queued in the same transaction as the order: a message exists only for
      // an order that was actually committed (lib/notifications).
      await queueOrderNotification(tx, order.id, "placed");

      return { kind: "placed" as const, order, paymentId: payment.id };
    });

  let outcome: Awaited<ReturnType<typeof attempt>>;
  try {
    // A deadlock or serialisation failure rolled everything back, so running
    // the whole transaction again cannot repeat any of its effects.
    outcome = await withTransientRetry(attempt);
  } catch (error) {
    // Belt and braces: the advisory lock should make this unreachable.
    if (isUniqueViolation(error, IDEMPOTENCY_CONSTRAINT)) {
      const existing = await findOrderByKey(db, input.idempotencyKey);
      if (existing) return reusedResult(existing);
    }
    if (isTransientDatabaseError(error)) throw new TransientConflictError();
    throw error;
  }

  if (outcome.kind === "reused") return reusedResult(outcome.order);

  const placed = outcome.order;
  let redirectUrl: string | null = null;
  let paymentStatus: PlacedOrder["paymentStatus"] = "initiated";

  try {
    const intent = await provider.createPayment({
      orderId: placed.id,
      orderNumber: placed.orderNumber,
      amountBdt: placed.amountDueNowBdt,
      method: input.method,
      customerEmail: input.guestEmail ?? "",
      idempotencyKey: input.idempotencyKey,
    });

    paymentStatus = intent.status === "failed" ? "failed" : "initiated";
    redirectUrl = intent.redirectUrl;

    await db
      .update(payments)
      .set({ providerRef: intent.providerRef, status: paymentStatus })
      .where(eq(payments.id, outcome.paymentId));
  } catch (error) {
    // The order stands and its hold expires on schedule; the payment row says
    // why nothing was charged. The provider's message is kept for staff only.
    paymentStatus = "failed";
    await db
      .update(payments)
      .set({
        status: "failed",
        rawPayload: { error: error instanceof Error ? error.message : String(error) },
      })
      .where(eq(payments.id, outcome.paymentId));
    console.error(`Payment could not be started for ${placed.orderNumber}.`);
  }

  // Delivery is outside the transaction and cannot fail the order.
  deliverQueuedNotificationsInBackground();

  return {
    orderId: placed.id,
    orderNumber: placed.orderNumber,
    totalBdt: placed.totalBdt,
    amountDueNowBdt: placed.amountDueNowBdt,
    redirectUrl,
    reused: false,
    paymentStatus,
  };
}
