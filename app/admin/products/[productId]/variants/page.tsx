import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import {
  getProductAttributes,
  getProductForAdmin,
  listAttributes,
  listVariants,
} from "@/lib/catalog";
import { VariantMatrix } from "./variant-matrix";

export const metadata: Metadata = { title: "Variants" };
export const dynamic = "force-dynamic";

export default async function ProductVariantsPage({
  params,
}: PageProps<"/admin/products/[productId]/variants">) {
  const { productId } = await params;
  const user = await getCurrentUser();

  const product = await getProductForAdmin(user, productId);
  if (!product) notFound();

  const [allAttributes, selected, variants] = await Promise.all([
    listAttributes(),
    getProductAttributes(productId),
    listVariants(user, productId),
  ]);

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
        <h1 className="mt-2 font-display text-h1 text-ink">Variants</h1>
      </div>

      <VariantMatrix
        productId={productId}
        attributes={allAttributes.map((attribute) => ({
          id: attribute.id,
          name: attribute.name,
          valueCount: attribute.values.length,
        }))}
        selectedAttributeIds={selected.map((row) => row.attributeId)}
        variants={variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          label: variant.label,
          priceBdt: variant.priceBdt,
          isEnabled: variant.isEnabled,
          fulfillmentMode: variant.fulfillmentMode,
          preorderCapacity: variant.preorderCapacity,
          preorderReserved: variant.preorderReserved,
        }))}
      />
    </div>
  );
}
