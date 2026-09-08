import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getProductForAdmin } from "@/lib/catalog";
import { StatusBadge } from "@/components/status-badge";

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

      {bullets.length > 0 ? (
        <section>
          <h2 className="font-display text-h2 text-ink">Key points</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {bullets.map((bullet) => (
              <li key={bullet} className="text-body text-ink/80">
                {bullet}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-meta text-ink/60">
        Editing, image upload, and the variation matrix arrive in Phase 5.
      </p>
    </div>
  );
}
