import { eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createProduct, PUBLIC_STATUSES } from "@/lib/catalog";

/**
 * Creates a product for a test that needs it already live.
 *
 * `createProduct` refuses a public status, because a new listing cannot pass
 * the publish check (D-056). Tests about carts, orders, search and the like
 * need a live listing without first adding photographs and a priced variant,
 * so this creates it through the real function — same permissions, same
 * validation — and then sets the status directly. It is a fixture shortcut,
 * not a way the application can publish.
 */
export async function createProductForTest(
  actor: SessionUser | null,
  input: Parameters<typeof createProduct>[1],
) {
  const { status, ...rest } = input;
  const live = status !== undefined && (PUBLIC_STATUSES as readonly string[]).includes(status);
  const created = await createProduct(actor, live ? rest : input);
  if (!live) return created;

  const [updated] = await db
    .update(products)
    .set({ status })
    .where(eq(products.id, created.id))
    .returning();
  return updated;
}
