import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProductForAdmin, listVariants } from "@/lib/catalog";
import { serverInstant } from "@/lib/clock";
import { countWaitlistByProduct } from "@/lib/preorder";
import { WindowControls } from "./window-controls";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: "Preorder windows" };
export const dynamic = "force-dynamic";

/**
 * Opening, extending and closing the preorder window on each variant.
 *
 * The capacity engine has been in place and tested since Phase 6, but the only
 * way to set a window was to type one in when the variant was created. This is
 * the screen that was missing, and it was the last thing standing between the
 * engine and someone actually running a batch with it.
 */
export default async function PreorderWindowsPage({
  params,
}: PageProps<"/admin/products/[productId]/windows">) {
  const { productId } = await params;
  const user = await requireAdminPage("catalog.manage");

  const product = await getProductForAdmin(user, productId);
  if (!product) notFound();

  const [variants, waiting, serverNow] = await Promise.all([
    listVariants(user, productId),
    countWaitlistByProduct(user, productId),
    serverInstant(),
  ]);

  const live = variants.filter((variant) => !variant.archivedAt);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="flex flex-wrap items-center gap-2 text-meta text-ink/70">
          <Link href="/admin/products" className="text-blue-600 underline-offset-4 hover:underline">
            Products
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            href={`/admin/products/${productId}`}
            className="text-blue-600 underline-offset-4 hover:underline"
          >
            {product.title}
          </Link>
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Preorder windows</h1>
        <p className="mt-2 max-w-[62ch] text-body text-ink/70">
          Closing a window never touches the places already reserved — those are
          orders that still have to be fulfilled. Closing is reversible:
          extending a closed window opens it again.
        </p>
      </div>

      {live.length === 0 ? (
        <p className="border border-blue-300 bg-paper p-4 text-body text-ink/70">
          This product has no variants yet.{" "}
          <Link
            href={`/admin/products/${productId}/variants`}
            className="text-blue-600 hover:underline"
          >
            Generate them first
          </Link>
          , then set a window on each.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {live.map((variant) => (
            <WindowControls
              key={variant.id}
              serverNow={serverNow}
              variant={{
                id: variant.id,
                sku: variant.sku,
                label: variant.label,
                fulfillmentMode: variant.fulfillmentMode,
                capacity: variant.preorderCapacity,
                reserved: variant.preorderReserved,
                closesAtIso: variant.preorderClosesAt
                  ? variant.preorderClosesAt.toISOString()
                  : null,
                waiting: waiting.get(variant.id) ?? 0,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
