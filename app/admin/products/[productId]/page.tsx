import type { Metadata } from "next";
import { IconArrowLeft } from "@/components/icons";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCategoryTree, getProductForAdmin, type CategoryNode } from "@/lib/catalog";
import { StatusBadge } from "@/components/status-badge";
import { getShowcaseSettings } from "@/lib/homepage";
import { ArchiveControls } from "./archive-controls";
import { EditProductForm } from "./edit-form";
import { ImageManager } from "./image-manager";
import { ShowcaseToggle } from "./showcase-toggle";

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
  const showcase = await getShowcaseSettings();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-2 text-meta text-blue-600 underline-offset-4 hover:underline"
        >
          <IconArrowLeft size={16} />
          Products
        </Link>
        <h1 className="mt-2 font-display text-h1 text-ink">{product.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StatusBadge tone={product.archivedAt ? "negative" : "neutral"}>
            {product.archivedAt ? "Archived" : product.status}
          </StatusBadge>
          <span className="text-meta text-ink/70">/{product.slug}</span>
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
        <h2 className="font-display text-h2 text-ink">Homepage</h2>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          The row of four under the hero. The card takes this
          product&rsquo;s main photograph, so changing what it shows is done in
          Photography below with <strong>Make main</strong>. The order of the
          row is set on the{" "}
          <Link
            href="/admin/homepage"
            className="text-blue-600 underline underline-offset-4"
          >
            homepage page
          </Link>
          .
        </p>
        <div className="mt-4">
          <ShowcaseToggle
            slug={product.slug}
            isFeatured={showcase.slugs.includes(product.slug)}
            isPublic={
              !product.archivedAt &&
              product.status !== "draft" &&
              product.status !== "archived"
            }
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
          href={`/admin/products/${product.id}/wizard?step=basics`}
          className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body surface-brass sheen text-ink shadow-[var(--shadow-raise)] hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04]"
        >
          Open setup wizard
        </Link>
        <Link
          href={`/admin/products/${product.id}/variants`}
          className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
        >
          Manage variants
        </Link>
        <Link
          href={`/admin/products/${product.id}/windows`}
          className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
        >
          Preorder windows
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
