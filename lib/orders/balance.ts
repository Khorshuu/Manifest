import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderStatusHistory, orders, payments, users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  deliverQueuedNotificationsInBackground,
  queueBalanceNotification,
} from "@/lib/notifications";
import { getPaymentProvider } from "@/lib/providers/payment";

/**
 * Taking the balance on a deposit order.
 *
 * DECISIONS.md D-012 settles the question DATABASE.md had left open: the
 * balance is **triggered by staff**, not charged automatically when the goods
 * land. The product owner chose this directly.
 *
 * Two rules from CLAUDE.md section 7 shape everything here. The amount is
 * computed on the server from the order's own rows — the caller passes an
 * order id and nothing else, so no request can name its own figure. And the
 * whole thing is idempotent: pressing the button twice, or two members of
 * staff pressing it at once, collects the balance once.
 */

export class BalanceError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "BalanceError";
  }
}

/** An order that cannot take a payment, whatever it is owed. */
const SETTLED_STATUSES = ["cancelled", "refunded"];

export type BalanceState = {
  /** Everything the order comes to. */
  totalBdt: number;
  /** What the customer has actually paid, refunds netted off. */
  paidBdt: number;
  /** What is still owed. Never negative. */
  outstandingBdt: number;
  /** Whether a balance can be taken right now, and why not if it cannot. */
  collectable: boolean;
  reason: string | null;
};

/**
 * What one order still owes, from its own payment rows.
 *
 * The payments are the source of truth rather than `amount_due_now_bdt`: that
 * column records what was asked for at placement, and a refund or a partial
 * capture afterwards would leave it describing history rather than the balance.
 */
export async function getBalanceState(
  orderId: string,
): Promise<BalanceState | null> {
  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      totalBdt: orders.totalBdt,
      archivedAt: orders.archivedAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  const [totals] = await db
    .select({
      // Refunds are stored as negative rows, so summing gives what is held.
      paid: sql<number>`coalesce(sum(${payments.amountBdt}), 0)::int`,
    })
    .from(payments)
    .where(
      and(eq(payments.orderId, orderId), ne(payments.status, "failed")),
    );

  const paidBdt = Number(totals?.paid ?? 0);
  const outstandingBdt = Math.max(0, order.totalBdt - paidBdt);

  const reason = order.archivedAt
    ? "That order has been archived."
    : SETTLED_STATUSES.includes(order.status)
      ? `That order is ${order.status}.`
      : outstandingBdt === 0
        ? "This order is paid in full."
        : null;

  return {
    totalBdt: order.totalBdt,
    paidBdt,
    outstandingBdt,
    collectable: reason === null,
    reason,
  };
}

export type BalanceResult = {
  orderId: string;
  amountBdt: number;
  /** True when the balance had already been taken before this call. */
  alreadyPaid: boolean;
};

/**
 * Charges whatever is still owed on an order, once.
 *
 * The idempotency has three layers, because a payment is the one place a
 * duplicate costs a real person real money:
 *
 * 1. An existing captured balance row short-circuits before the provider is
 *    called at all.
 * 2. An existing *initiated* balance row is resumed rather than replaced, so a
 *    request that died between creating the intent and capturing it does not
 *    leave a second charge behind.
 * 3. The provider is handed a key derived from the order, so even a provider
 *    that is called twice returns one charge.
 */
export async function takeBalancePayment(
  actor: SessionUser | null,
  orderId: string,
): Promise<BalanceResult> {
  const staff = requirePermission(actor, "orders.manage");

  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalBdt: orders.totalBdt,
      archivedAt: orders.archivedAt,
      guestEmail: orders.guestEmail,
      userEmail: users.email,
    })
    .from(orders)
    .leftJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) throw new BalanceError("That order no longer exists.");

  const state = await getBalanceState(orderId);
  if (!state) throw new BalanceError("That order no longer exists.");

  // An already-settled balance is reported, not refused: pressing the button
  // twice should say "already done", not read as a failure.
  const [existing] = await db
    .select({
      id: payments.id,
      status: payments.status,
      amountBdt: payments.amountBdt,
      providerRef: payments.providerRef,
    })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.kind, "balance")))
    .limit(1);

  if (existing?.status === "captured") {
    return {
      orderId,
      amountBdt: existing.amountBdt,
      alreadyPaid: true,
    };
  }

  if (!state.collectable) {
    throw new BalanceError(state.reason ?? "That balance cannot be taken.");
  }

  const recipient = order.userEmail ?? order.guestEmail;
  if (!recipient) {
    throw new BalanceError(
      "That order has no contact address, so a balance cannot be taken.",
    );
  }

  const provider = getPaymentProvider();
  const amountBdt = state.outstandingBdt;

  // Resume a half-finished attempt rather than starting a second one.
  let paymentId = existing?.id ?? null;
  let providerRef = existing?.providerRef ?? null;

  if (!providerRef) {
    const intent = await provider.createPayment({
      orderId,
      orderNumber: order.orderNumber,
      amountBdt,
      method: "bkash",
      customerEmail: recipient,
      // Derived from the order, so a retry of this request cannot charge twice
      // even if it reaches the provider again.
      idempotencyKey: `balance:${orderId}`,
    });

    providerRef = intent.providerRef;

    const [row] = await db
      .insert(payments)
      .values({
        orderId,
        kind: "balance",
        provider: provider.name,
        providerRef,
        method: "bkash",
        amountBdt,
        status: "initiated",
      })
      .returning({ id: payments.id });

    paymentId = row.id;
  }

  const captured = await provider.capture(providerRef);

  if (captured.status === "failed") {
    await db
      .update(payments)
      .set({ status: "failed" })
      .where(eq(payments.id, paymentId!));

    throw new BalanceError("That payment was declined.");
  }

  return db.transaction(async (tx) => {
    // Guarded on the current status, so two staff pressing at once produce one
    // capture and the loser is told it was already done.
    const updated = await tx
      .update(payments)
      .set({ status: "captured" })
      .where(and(eq(payments.id, paymentId!), eq(payments.status, "initiated")))
      .returning({ id: payments.id, amountBdt: payments.amountBdt });

    if (updated.length === 0) {
      return { orderId, amountBdt, alreadyPaid: true };
    }

    await tx.insert(orderStatusHistory).values({
      orderId,
      // The stage does not move: this is money, not fulfilment.
      status: order.status,
      note: `Balance taken (${providerRef}).`,
      actorUserId: staff.id,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "order.balance_taken",
        entityType: "order",
        entityId: orderId,
        before: { paidBdt: state.paidBdt, outstandingBdt: amountBdt },
        after: { paidBdt: state.paidBdt + amountBdt, outstandingBdt: 0 },
      },
      tx,
    );

    await queueBalanceNotification(tx, orderId, amountBdt);

    deliverQueuedNotificationsInBackground();

    return { orderId, amountBdt, alreadyPaid: false };
  });
}
