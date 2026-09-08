import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, productVariants, products } from "@/db/schema";
import { requireStaff, requireSuperAdmin } from "@/lib/auth/authorize";
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

export async function exportOrdersCsv(
  actor: SessionUser | null,
): Promise<string> {
  requireStaff(actor);

  const rows = await db
    .select({
      orderNumber: orders.orderNumber,
      status: orders.status,
      placedAt: orders.placedAt,
      email: orders.guestEmail,
      subtotalBdt: orders.subtotalBdt,
      totalBdt: orders.totalBdt,
      amountDueNowBdt: orders.amountDueNowBdt,
      trackingReference: orders.trackingReference,
      itemCount: sql<number>`(
        select coalesce(sum(quantity), 0)::int from order_items
        where order_items.order_id = orders.id
      )`,
    })
    .from(orders)
    .orderBy(desc(orders.placedAt));

  return toCsv(
    [
      "Order number",
      "Status",
      "Placed at",
      "Customer email",
      "Items",
      "Subtotal (BDT)",
      "Total (BDT)",
      "Collected (BDT)",
      "Tracking reference",
    ],
    rows.map((row) => [
      row.orderNumber,
      row.status,
      row.placedAt.toISOString(),
      row.email,
      row.itemCount,
      takaFromPaisa(row.subtotalBdt),
      takaFromPaisa(row.totalBdt),
      takaFromPaisa(row.amountDueNowBdt),
      row.trackingReference,
    ]),
  );
}

/**
 * The preorder capacity report: what has been committed against what was
 * offered, per variant.
 */
export async function exportPreordersCsv(
  actor: SessionUser | null,
): Promise<string> {
  requireStaff(actor);

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
  requireSuperAdmin(actor);

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
