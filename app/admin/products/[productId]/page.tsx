import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCategoryTree, getProductForAdmin, type CategoryNode } from "@/lib/catalog";
import { StatusBadge } from "@/components/status-badge";
import { ArchiveControls } from "./archive-controls";
import { EditProductForm } from "./edit-form";
import { ImageManager } from "./image-manager";

/** Flattens the tree into indented options, so nesting is visible in a select. */
function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

export const metadata: Metadata = { title: "Product" };
export const dynamic = "force-dynamic";

export default async function AdminProductPage({
  params,
}: PageProps<"/admin/products/[productId]">) {
  const { productId } = await params;
  const user = await getCurrentUser();
  const product = await getProductForAdmin(user, productId);

  if (!product) notFound();

  const bullets = Array.isArray(product.bulletFeatures)
    ? (product.bulletFeatures as string[])
    : [];
  const categories = flatten(await getCategoryTree());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-meta text-blue-400">
          <Link href="/admin/products" className="hover:underline">
            Products
          </Link>
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">{product.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StatusBadge tone={product.archivedAt ? "negative" : "neutral"}>
            {product.archivedAt ? "Archived" : product.status}
          </StatusBadge>
          <span className="text-meta text-ink/60">/{product.slug}</span>
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-px border border-blue-300 bg-blue-300 sm:grid-cols-2">
        <div className="bg-paper p-4">
          <dt className="text-meta text-ink/70">Brand</dt>
          <dd className="mt-1 text-body text-ink">{product.brand ?? "—"}</dd>
        </div>
        <div className="bg-paper p-4">
          <dt className="text-meta text-ink/70">Images</dt>
          <dd className="mt-1 text-body text-ink tabular-nums">
            {product.images.length}
          </dd>
        </div>
      </dl>

      <section>
        <h2 className="font-display text-h2 text-ink">Details</h2>
        <div className="mt-4">
          {/* Keyed on the record's own timestamp: the inputs are uncontrolled,
              so a refreshed status has to arrive through a remount. */}
          <EditProductForm
            key={product.updatedAt.toISOString()}
            categories={categories}
            product={{
              id: product.id,
              title: product.title,
              brand: product.brand,
              categoryId: product.categoryId,
              status: product.status,
              descriptionHtml: product.descriptionHtml,
              bulletFeatures: bullets,
              seoMetaTitle: product.seoMetaTitle,
              seoMetaDescription: product.seoMetaDescription,
              archived: product.archivedAt !== null,
              specTable: (product.specTable as
                | { label: string; value: string }[]
                | null) ?? null,
              tags: (product.tags as string[] | null) ?? null,
            }}
          />
        </div>
      </section>

      <section>
        <h2 className="font-display text-h2 text-ink">Photography</h2>
        <div className="mt-4">
          <ImageManager
            productId={product.id}
            images={product.images.map((image) => ({
              id: image.id,
              url: image.url,
              altText: image.altText,
            }))}
          />
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link
          href={`/admin/products/${product.id}/variants`}
          className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
        >
          Manage variants
        </Link>
      </div>

      <section className="border-t border-blue-300 pt-6">
        <h2 className="font-display text-h2 text-ink">
          {product.archivedAt ? "Restore this product" : "Archive this product"}
        </h2>
        <div className="mt-3">
          <ArchiveControls
            productId={product.id}
            archived={product.archivedAt !== null}
          />
        </div>
      </section>
    </div>
  );
}
