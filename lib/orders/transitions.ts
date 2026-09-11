import { and, asc, desc, eq, gte, ilike, isNotNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  users,
  type OrderStatus,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  deliverQueuedNotificationsInBackground,
  queueOrderNotification,
  queuePartialRefundNotification,
} from "@/lib/notifications";
import { releaseCapacity } from "@/lib/preorder";

/**
 * Order status transitions.
 *
 * Status only moves forward through the pipeline, or sideways into cancelled
 * or refunded. Nothing writes a status backward: a correction is a new history
 * row with a note, never a rewrite (docs/BUSINESS_LOGIC.md).
 */

const PIPELINE: OrderStatus[] = [
  "placed",
  "payment_confirmed",
  "sourcing",
  "shipped_from_us",
  "in_bd_customs",
  "out_for_delivery",
  "delivered",
];

const TERMINAL: OrderStatus[] = ["cancelled", "refunded"];

export class TransitionError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

/** Statuses reachable from the current one. */
export function allowedTransitions(current: string): OrderStatus[] {
  if (TERMINAL.includes(current as OrderStatus)) return [];

  const index = PIPELINE.indexOf(current as OrderStatus);
  if (index === -1) return [];

  const next = PIPELINE[index + 1];
  const forward = next ? [next] : [];

  // Delivered is the end of the road for cancellation; a delivered order is
  // handled as a refund instead.
  return current === "delivered"
    ? ["refunded"]
    : [...forward, "cancelled", "refunded"];
}

export function canTransition(from: string, to: string): boolean {
  return allowedTransitions(from).includes(to as OrderStatus);
}

/**
 * Capacity is only released while the order still holds it. Once an order is
 * sourcing or beyond, the item has been bought in the US and the slot is
 * genuinely consumed.
 */
function stillHoldsCapacity(status: string): boolean {
  return status === "placed" || status === "payment_confirmed";
}

export async function advanceOrder(
  actor: SessionUser | null,
  orderId: string,
  to: OrderStatus,
  note?: string,
) {
  const staff = requirePermission(actor, "orders.manage");

  const moved = await db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId));

    if (!order) throw new TransitionError("That order no longer exists.");

    if (!canTransition(order.status, to)) {
      throw new TransitionError(
        `An order that is ${order.status.replace(/_/g, " ")} cannot move to ${to.replace(/_/g, " ")}.`,
      );
    }

    // Cancelling gives the slots back, so someone else can take them.
    if (to === "cancelled" && stillHoldsCapacity(order.status)) {
      const items = await tx
        .select({
          variantId: orderItems.variantId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      for (const item of items) {
        await releaseCapacity(tx, item.variantId, item.quantity);
      }
    }

    await tx
      .update(orders)
      .set({ status: to })
      .where(eq(orders.id, orderId));

    await tx.insert(orderStatusHistory).values({
      orderId,
      status: to,
      note: note ?? null,
      actorUserId: staff.id,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "order.status_changed",
        entityType: "order",
        entityId: orderId,
        before: { status: order.status },
        after: { status: to },
      },
      tx,
    );

    // Every stage of an import is worth telling someone about; the outbox row
    // is written with the status change, not after it.
    await queueOrderNotification(tx, orderId, to);

    return { orderId, status: to };
  });

  deliverQueuedNotificationsInBackground();

  return moved;
}

/**
 * What each charge on an order still has left to refund.
 *
 * A refund row points at the charge it reverses, so a charge's remaining
 * amount is itself less the refunds against it. Without that link a refund is
 * only a negative number against the order, and a second partial refund has no
 * way to know whether it is about to return more than was ever taken.
 */
export type RefundableCharge = {
  id: string;
  providerRef: string;
  remainingBdt: number;
};

async function refundableCharges(
  orderId: string,
): Promise<RefundableCharge[]> {
  const rows = await db
    .select({
      id: payments.id,
      kind: payments.kind,
      status: payments.status,
      providerRef: payments.providerRef,
      amountBdt: payments.amountBdt,
      refundedPaymentId: payments.refundedPaymentId,
    })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(payments.createdAt);

  const refundedByCharge = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "refund" || !row.refundedPaymentId) continue;
    refundedByCharge.set(
      row.refundedPaymentId,
      (refundedByCharge.get(row.refundedPaymentId) ?? 0) + Math.abs(row.amountBdt),
    );
  }

  return rows
    .filter(
      (row) =>
        row.kind !== "refund" &&
        row.status !== "failed" &&
        row.providerRef !== null &&
        row.amountBdt > 0,
    )
    .map((row) => ({
      id: row.id,
      providerRef: row.providerRef!,
      remainingBdt: row.amountBdt - (refundedByCharge.get(row.id) ?? 0),
    }))
    .filter((charge) => charge.remainingBdt > 0);
}

/** Everything still refundable on an order, across all its charges. */
export async function refundableTotal(orderId: string): Promise<number> {
  const charges = await refundableCharges(orderId);
  return charges.reduce((sum, charge) => sum + charge.remainingBdt, 0);
}

/**
 * Records a refund that staff have already made by hand.
 *
 * The money moves outside this system. The product owner's rule is that
 * refunds are paid manually against terms they will set — see DECISIONS.md
 * D-015 — so this does not call the payment gateway. It records what was paid
 * back, against which charge, by whom, and with the reference of the transfer
 * they made, which is what makes the books reconcilable afterwards.
 *
 * It still always produces a payment row of kind 'refund'. A refund is never a
 * silent adjustment to a figure on the order (docs/SECURITY.md).
 *
 * `amountBdt` records a partial refund and leaves the order where it is: a
 * part refund is a price correction or a goodwill payment, not the end of the
 * order, and the goods are still coming. Omitting it records the whole
 * remaining amount and moves the order to `refunded`, which is what releases
 * any capacity still being held.
 */
export async function refundOrder(
  actor: SessionUser | null,
  orderId: string,
  reason: string,
  options: { amountBdt?: number; reference?: string } = {},
) {
  const staff = requirePermission(actor, "orders.manage");

  const [order] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!order) throw new TransitionError("That order no longer exists.");

  if (order.status === "refunded") {
    throw new TransitionError("That order has already been refunded.");
  }

  const charges = await refundableCharges(orderId);
  const available = charges.reduce(
    (sum, charge) => sum + charge.remainingBdt,
    0,
  );

  const partial = options.amountBdt !== undefined;

  if (partial) {
    const requested = options.amountBdt!;

    if (!Number.isInteger(requested) || requested <= 0) {
      throw new TransitionError("A refund amount must be a positive figure.");
    }

    if (requested > available) {
      throw new TransitionError(
        available === 0
          ? "There is nothing left to refund on this order."
          : `Only ${available / 100} taka is left to refund on this order.`,
      );
    }
  }

  /*
   * Taken from the charges in the order they were made, so the oldest is
   * reversed first and a part refund spanning two charges splits between them
   * rather than being refused.
   *
   * `provider` is recorded as "manual" and the reference is whatever staff
   * typed — the bKash or bank transaction they made. Nothing here contacts a
   * gateway, so nothing here can fail halfway and leave the customer's money in
   * a state this system cannot see.
   */
  let outstanding = partial ? options.amountBdt! : available;

  for (const charge of charges) {
    if (outstanding <= 0) break;

    const amount = Math.min(outstanding, charge.remainingBdt);

    await db.insert(payments).values({
      orderId,
      kind: "refund",
      provider: "manual",
      providerRef: options.reference?.trim() || null,
      // Recorded as a negative amount, so the sum of a customer's payment rows
      // is what they actually paid.
      amountBdt: -amount,
      status: "refunded",
      refundedPaymentId: charge.id,
    });

    outstanding -= amount;
  }

  /*
   * A partial refund stops here. The order keeps its status and its capacity:
   * the shopper is still expecting the goods, and moving it to `refunded`
   * would tell them — and every revenue figure — that the sale had ended.
   */
  if (partial) {
    await recordAudit({
      actorUserId: staff.id,
      action: "order.refunded",
      entityType: "order",
      entityId: orderId,
      before: { refundableBdt: available },
      after: {
        refundedBdt: options.amountBdt,
        refundableBdt: available - options.amountBdt!,
        reason,
        partial: true,
      },
    });

    await queuePartialRefundNotification(db, orderId, options.amountBdt!);
    deliverQueuedNotificationsInBackground();

    return {
      orderId,
      status: order.status,
      refunded: 1,
      amountBdt: options.amountBdt!,
      partial: true as const,
    };
  }

  const refunded = await db.transaction(async (tx) => {
    if (stillHoldsCapacity(order.status)) {
      const items = await tx
        .select({
          variantId: orderItems.variantId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      for (const item of items) {
        await releaseCapacity(tx, item.variantId, item.quantity);
      }
    }

    await tx
      .update(orders)
      .set({ status: "refunded" })
      .where(eq(orders.id, orderId));

    await tx.insert(orderStatusHistory).values({
      orderId,
      status: "refunded",
      note: reason,
      actorUserId: staff.id,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "order.refunded",
        entityType: "order",
        entityId: orderId,
        before: { status: order.status },
        after: { status: "refunded", reason },
      },
      tx,
    );

    // The reason is staff wording and stays out of the message: the customer
    // is told a refund was issued, not what an internal note said.
    await queueOrderNotification(tx, orderId, "refunded");

    return {
      orderId,
      status: "refunded" as const,
      refunded: charges.length,
      amountBdt: available,
      partial: false as const,
    };
  });

  deliverQueuedNotificationsInBackground();

  return refunded;
}

export class CancellationError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "CancellationError";
  }
}

/**
 * A shopper asks to cancel their own order.
 *
 * This records a request; it does not cancel anything. Staff review it, speak
 * to the customer, and make the final decision from the admin side — the
 * product owner's rule, recorded as DECISIONS.md D-014.
 *
 * Two consequences worth stating plainly, because both are changes from what
 * this used to do. The order keeps its status, so it keeps moving through the
 * pipeline until somebody decides otherwise. And it keeps its capacity: the
 * place stays the shopper's until the request is answered, because releasing
 * it early would sell their place to somebody else while they were still
 * waiting to hear.
 */
export async function requestCancellation(
  actor: SessionUser | null,
  orderId: string,
  reason: string,
) {
  if (!actor) throw new CancellationError("Sign in to cancel an order.");

  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      userId: orders.userId,
      cancellationRequestedAt: orders.cancellationRequestedAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!order) throw new CancellationError("That order no longer exists.");

  if (order.userId !== actor.id) {
    throw new CancellationError("That order is not yours.");
  }

  if (TERMINAL.includes(order.status as OrderStatus)) {
    throw new CancellationError(
      `This order is already ${order.status}, so there is nothing to cancel.`,
    );
  }

  if (order.status === "delivered") {
    throw new CancellationError(
      "This order has already been delivered. Contact us and we will look at it with you.",
    );
  }

  // Asking twice is not an error — it is somebody wondering whether the first
  // one registered. Report the request they already have.
  if (order.cancellationRequestedAt) {
    return {
      orderId,
      status: order.status,
      requestedAt: order.cancellationRequestedAt,
      alreadyRequested: true,
    };
  }

  const requestedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({
        cancellationRequestedAt: requestedAt,
        // The customer's own wording, kept away from internalNotes.
        cancellationReason: reason.trim() || null,
      })
      .where(eq(orders.id, orderId));

    await tx.insert(orderStatusHistory).values({
      orderId,
      // The stage does not move: nothing has been decided yet.
      status: order.status,
      note: "Cancellation requested by the shopper.",
      actorUserId: actor.id,
    });
  });

  return {
    orderId,
    status: order.status,
    requestedAt,
    alreadyRequested: false,
  };
}

/**
 * Staff answer a cancellation request.
 *
 * Approving runs the ordinary cancellation, so capacity comes back and the
 * customer is told through the same message as any other cancellation.
 * Declining clears the request and leaves the order where it was — the
 * conversation that produced the decision belongs in an internal note, not
 * here.
 */
export async function resolveCancellationRequest(
  actor: SessionUser | null,
  orderId: string,
  decision: "approve" | "decline",
  note?: string,
) {
  const staff = requirePermission(actor, "orders.manage");

  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      cancellationRequestedAt: orders.cancellationRequestedAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId));

  if (!order) throw new CancellationError("That order no longer exists.");

  if (!order.cancellationRequestedAt) {
    throw new CancellationError(
      "There is no cancellation request on that order.",
    );
  }

  if (decision === "decline") {
    await db.transaction(async (tx) => {
      await tx
        .update(orders)
        .set({ cancellationRequestedAt: null, cancellationReason: null })
        .where(eq(orders.id, orderId));

      await tx.insert(orderStatusHistory).values({
        orderId,
        status: order.status,
        note: note?.trim()
          ? `Cancellation declined: ${note.trim()}`
          : "Cancellation declined.",
        actorUserId: staff.id,
      });

      await recordAudit(
        {
          actorUserId: staff.id,
          action: "order.status_changed",
          entityType: "order",
          entityId: orderId,
          before: { cancellationRequested: true },
          after: { cancellationRequested: false, decision: "declined" },
        },
        tx,
      );
    });

    return { orderId, status: order.status, decision: "decline" as const };
  }

  if (!canTransition(order.status, "cancelled")) {
    throw new CancellationError(
      `An order that is ${order.status.replace(/_/g, " ")} can no longer be cancelled.`,
    );
  }

  const result = await advanceOrder(
    actor,
    orderId,
    "cancelled",
    note?.trim() || "Cancellation approved after review.",
  );

  // Cleared after the transition, so a failure part-way leaves the request
  // visible in the queue rather than losing it silently.
  await db
    .update(orders)
    .set({ cancellationRequestedAt: null })
    .where(eq(orders.id, orderId));

  return { ...result, decision: "approve" as const };
}

/** Orders whose shoppers have asked to cancel, oldest request first. */
export async function listCancellationRequests(actor: SessionUser | null) {
  requirePermission(actor, "orders.view");

  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalBdt: orders.totalBdt,
      requestedAt: orders.cancellationRequestedAt,
      reason: orders.cancellationReason,
      placedAt: orders.placedAt,
    })
    .from(orders)
    .where(isNotNull(orders.cancellationRequestedAt))
    .orderBy(orders.cancellationRequestedAt);
}

/** Staff order pipeline, filterable by status. */
export async function listOrdersForStaff(
  actor: SessionUser | null,
  filter: { status?: OrderStatus } = {},
) {
  requirePermission(actor, "orders.view");

  const query = db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalBdt: orders.totalBdt,
      amountDueNowBdt: orders.amountDueNowBdt,
      placedAt: orders.placedAt,
      guestEmail: orders.guestEmail,
      userId: orders.userId,
    })
    .from(orders)
    .orderBy(orders.placedAt);

  const rows = filter.status
    ? await query.where(eq(orders.status, filter.status))
    : await query;

  return rows;
}

export type StaffOrderQuery = {
  /** Order number, customer email, phone or name. */
  q?: string;
  status?: OrderStatus;
  /** Inclusive start and exclusive end of the placement date. */
  from?: Date;
  to?: Date;
  sort?: "newest" | "oldest" | "total_desc" | "total_asc";
  limit?: number;
  offset?: number;
};

/**
 * The admin order list: searchable, filterable by status and date, sortable,
 * and carrying what a person scanning the list needs — who ordered, how many
 * items and the first of them — so most questions are answered without
 * opening the order.
 */
export async function searchOrdersForStaff(
  actor: SessionUser | null,
  query: StaffOrderQuery = {},
) {
  requirePermission(actor, "orders.view");

  const term = query.q?.trim();
  const pattern = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const where = and(
    query.status ? eq(orders.status, query.status) : undefined,
    query.from ? gte(orders.placedAt, query.from) : undefined,
    query.to ? lt(orders.placedAt, query.to) : undefined,
    pattern
      ? or(
          ilike(orders.orderNumber, pattern),
          ilike(orders.guestEmail, pattern),
          ilike(orders.guestPhone, pattern),
          ilike(users.email, pattern),
          ilike(users.phone, pattern),
          ilike(users.firstName, pattern),
          ilike(users.lastName, pattern),
        )
      : undefined,
  );

  const order =
    query.sort === "oldest"
      ? asc(orders.placedAt)
      : query.sort === "total_desc"
        ? desc(orders.totalBdt)
        : query.sort === "total_asc"
          ? asc(orders.totalBdt)
          : desc(orders.placedAt);

  const items = db
    .select({
      orderId: orderItems.orderId,
      itemCount: sql<number>`sum(${orderItems.quantity})::int`.as("item_count"),
      firstTitle: sql<string>`min(${orderItems.titleSnapshot})`.as("first_title"),
      lines: sql<number>`count(*)::int`.as("lines"),
      preorder: sql<boolean>`bool_or(${orderItems.fulfillmentModeSnapshot} = 'preorder')`.as("has_preorder"),
    })
    .from(orderItems)
    .groupBy(orderItems.orderId)
    .as("items");

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        totalBdt: orders.totalBdt,
        amountDueNowBdt: orders.amountDueNowBdt,
        placedAt: orders.placedAt,
        cancellationRequestedAt: orders.cancellationRequestedAt,
        guestEmail: orders.guestEmail,
        userId: orders.userId,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        itemCount: items.itemCount,
        lines: items.lines,
        firstTitle: items.firstTitle,
        hasPreorder: items.preorder,
      })
      .from(orders)
      .leftJoin(users, eq(orders.userId, users.id))
      .leftJoin(items, eq(items.orderId, orders.id))
      .where(where)
      .orderBy(order)
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(orders)
      .leftJoin(users, eq(orders.userId, users.id))
      .where(where),
  ]);

  return {
    orders: rows.map((row) => ({
      ...row,
      itemCount: Number(row.itemCount ?? 0),
      lines: Number(row.lines ?? 0),
      customerName:
        [row.firstName, row.lastName].filter(Boolean).join(" ") || null,
      customerEmail: row.email ?? row.guestEmail ?? null,
      isGuest: row.userId === null,
    })),
    total: Number(total?.value ?? 0),
  };
}
