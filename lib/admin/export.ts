import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orders, productVariants, products, users } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * CSV export.
 *
 * Amounts are written in taka with two decimals rather than raw paisa, because
 * a spreadsheet is read by a person. The internal sourcing cost only appears
 * in the export a super admin can request.
 */

/**
 * Escapes one CSV field.
 *
 * The leading apostrophe on a value starting with = + - or @ is deliberate:
 * without it a spreadsheet treats the cell as a formula, which is how CSV
 * injection works.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";

  const text = String(value);
  const needsGuard = /^[=+\-@\t\r]/.test(text);
  const guarded = needsGuard ? `'${text}` : text;

  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  return guarded;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  // CRLF: what spreadsheet software expects from a CSV.
  return lines.join("\r\n");
}

/** Paisa to a taka string with two decimals. */
export function takaFromPaisa(paisa: number): string {
  return (paisa / 100).toFixed(2);
}

const ORDER_CSV_HEADERS = [
  "Order number",
  "Status",
  "Placed at",
  "Customer email",
  "Items",
  "Subtotal (BDT)",
  "Total (BDT)",
  "Collected (BDT)",
  "Tracking reference",
];

const EXPORT_BATCH = 1000;

/**
 * Every order as CSV, streamed.
 *
 * Read in batches of a thousand by keyset on (placed_at, id), newest first,
 * and written out as each batch arrives, so memory stays flat however many
 * orders there are. The whole file used to be built as one string: 8 MB and
 * 960 ms at 100,000 orders, before a byte was sent.
 */
export function streamOrdersCsv(actor: SessionUser | null): ReadableStream<Uint8Array> {
  requirePermission(actor, "orders.view");
  const encoder = new TextEncoder();
  let cursor: { placedAt: Date; id: string } | null = null;
  let started = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(ORDER_CSV_HEADERS.map(csvField).join(",")));
      }

      const position: { placedAt: Date; id: string } | null = cursor;
      const batch = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          status: orders.status,
          placedAt: orders.placedAt,
          email: sql<string | null>`coalesce(${users.email}, ${orders.guestEmail})`,
          subtotalBdt: orders.subtotalBdt,
          totalBdt: orders.totalBdt,
          amountDueNowBdt: orders.amountDueNowBdt,
          trackingReference: orders.trackingReference,
        })
        .from(orders)
        .leftJoin(users, eq(users.id, orders.userId))
        .where(
          position
            ? sql`(${orders.placedAt}, ${orders.id}) < (${position.placedAt.toISOString()}::timestamptz, ${position.id}::uuid)`
            : undefined,
        )
        .orderBy(desc(orders.placedAt), desc(orders.id))
        .limit(EXPORT_BATCH);

      if (batch.length === 0) {
        controller.close();
        return;
      }

      const counts = await db
        .select({
          orderId: orderItems.orderId,
          items: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, batch.map((row) => row.id)))
        .groupBy(orderItems.orderId);
      const itemsOf = new Map(counts.map((row) => [row.orderId, Number(row.items)]));

      const lines = batch.map((row) =>
        [
          row.orderNumber,
          row.status,
          row.placedAt.toISOString(),
          row.email,
          itemsOf.get(row.id) ?? 0,
          takaFromPaisa(row.subtotalBdt),
          takaFromPaisa(row.totalBdt),
          takaFromPaisa(row.amountDueNowBdt),
          row.trackingReference,
        ]
          .map(csvField)
          .join(","),
      );
      controller.enqueue(encoder.encode("\r\n" + lines.join("\r\n")));

      const last = batch[batch.length - 1];
      cursor = { placedAt: last.placedAt, id: last.id };
      if (batch.length < EXPORT_BATCH) controller.close();
    },
  });
}

/** The same export as one string, for small callers and tests. */
export async function exportOrdersCsv(actor: SessionUser | null): Promise<string> {
  return new Response(streamOrdersCsv(actor)).text();
}

/**
 * The preorder capacity report: what has been committed against what was
 * offered, per variant.
 */
export async function exportPreordersCsv(
  actor: SessionUser | null,
): Promise<string> {
  requirePermission(actor, "orders.view");

  const rows = await db
    .select({
      title: products.title,
      sku: productVariants.sku,
      capacity: productVariants.preorderCapacity,
      reserved: productVariants.preorderReserved,
      priceBdt: productVariants.priceBdt,
      closesAt: productVariants.preorderClosesAt,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.fulfillmentMode, "preorder"))
    .orderBy(products.title, productVariants.sku);

  return toCsv(
    [
      "Product",
      "SKU",
      "Capacity",
      "Reserved",
      "Remaining",
      "Price (BDT)",
      "Closes at",
    ],
    rows.map((row) => [
      row.title,
      row.sku,
      row.capacity,
      row.reserved,
      row.capacity === null ? "" : Math.max(0, row.capacity - row.reserved),
      takaFromPaisa(row.priceBdt),
      row.closesAt?.toISOString() ?? "",
    ]),
  );
}

/**
 * The margin report. Super admin only: it is the one export that carries the
 * US sourcing cost (docs/SECURITY.md).
 */
export async function exportMarginCsv(
  actor: SessionUser | null,
): Promise<string> {
  requirePermission(actor, "finance.view");

  const rows = await db
    .select({
      title: products.title,
      sku: productVariants.sku,
      priceBdt: productVariants.priceBdt,
      costPriceUsd: productVariants.costPriceUsd,
      reserved: productVariants.preorderReserved,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .orderBy(products.title, productVariants.sku);

  return toCsv(
    ["Product", "SKU", "Sell price (BDT)", "Cost (USD)", "Units committed"],
    rows.map((row) => [
      row.title,
      row.sku,
      takaFromPaisa(row.priceBdt),
      row.costPriceUsd === null ? "" : (row.costPriceUsd / 100).toFixed(2),
      row.reserved,
    ]),
  );
}
