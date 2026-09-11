import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProductForAdmin } from "@/lib/catalog";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { loadVariantManager } from "./manager-props";
import { VariantMatrix } from "./variant-matrix";

export const metadata: Metadata = { title: "Variants" };
export const dynamic = "force-dynamic";

/**
 * The variants manager on its own page. The same manager is section 3 of the
 * product editor; this page stays for direct links.
 */
export default async function ProductVariantsPage({
  params,
}: PageProps<"/admin/products/[productId]/variants">) {
  const { productId } = await params;
  const user = await requireAdminPage("catalog.manage");

  const product = await getProductForAdmin(user, productId);
  if (!product) notFound();

  const manager = await loadVariantManager(user, product);

  return (
    <div className="flex flex-col gap-6">
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
        <h1 className="mt-2 font-display text-h1 text-ink">Variants</h1>
        <p className="mt-1 text-meta text-ink/70">
          Variants, pricing and inventory for this product only.
        </p>
      </div>

      <div className="admin-card">
        <VariantMatrix {...manager} />
      </div>
    </div>
  );
}
