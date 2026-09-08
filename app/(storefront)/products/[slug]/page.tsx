import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductCard } from "@/components/product-card";
import {
  findCategoryPath,
  getCategoryTree,
  getPublicProductBySlug,
  getPublicVariants,
  listRelatedProducts,
} from "@/lib/catalog";
import { remainingCapacity } from "@/lib/catalog/variants";
import { formatArrivalWindow, formatDate } from "@/lib/format";
import { breadcrumbJsonLd, productJsonLd } from "@/lib/seo";
import { getProductRating } from "@/lib/catalog";
import { getCurrentUser } from "@/lib/auth";
import {
  findEligibleOrderItem,
  getRatingBreakdown,
  hasReviewed,
  listApprovedReviews,
} from "@/lib/reviews";
import { ReviewsSection } from "./reviews-section";
import { VariantPicker, type PickerVariant } from "./variant-picker";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps<"/products/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getPublicProductBySlug(slug);

  if (!product) return { title: "Product not found" };

  return {
    title: product.seoMetaTitle ?? product.title,
    description: product.seoMetaDescription ?? undefined,
    alternates: { canonical: `/products/${product.slug}` },
  };
}

export default async function ProductPage({
  params,
}: PageProps<"/products/[slug]">) {
  const { slug } = await params;
  const product = await getPublicProductBySlug(slug);
  if (!product) notFound();

  const [variants, tree, related, rating, reviews, breakdown, user] =
    await Promise.all([
      getPublicVariants(product.id),
      getCategoryTree(),
      listRelatedProducts(product.id, product.categoryId, 4),
      getProductRating(product.id),
      listApprovedReviews(product.id),
      getRatingBreakdown(product.id),
      getCurrentUser(),
    ]);

  // Both decided on the server: the form is only rendered for someone whose
  // delivered order entitles them to it, and submitting re-checks the same
  // thing rather than trusting the page.
  const [eligible, alreadyReviewed] = user
    ? await Promise.all([
        findEligibleOrderItem(user.id, product.id),
        hasReviewed(user.id, product.id),
      ])
    : [null, false];

  const breadcrumb = findCategoryPath(tree, product.categoryId);

  // Availability and dates are settled before render — the window state comes
  // from the database, so there is one clock rather than one per process.
  const pickerVariants: PickerVariant[] = variants.map((variant) => ({
    id: variant.id,
    label: variant.label,
    priceBdt: variant.priceBdt,
    fulfillmentMode: variant.fulfillmentMode,
    remaining:
      variant.fulfillmentMode === "preorder"
        ? remainingCapacity(variant)
        : variant.stockQuantity,
    isClosed: Boolean(variant.isClosed),
    closesAtLabel: variant.preorderClosesAt
      ? formatDate(variant.preorderClosesAt)
      : null,
    arrivalLabel: formatArrivalWindow(
      variant.estimatedArrivalFrom,
      variant.estimatedArrivalTo,
    ),
    paymentMode: variant.paymentMode,
    depositPercent: variant.depositPercent,
  }));

  const bullets = Array.isArray(product.bulletFeatures)
    ? (product.bulletFeatures as string[])
    : [];
  const specs = Array.isArray(product.specTable)
    ? (product.specTable as { label: string; value: string }[])
    : [];

  // Built from the values rendered below, so the two cannot drift apart.
  const cheapest = pickerVariants.reduce<(typeof pickerVariants)[number] | null>(
    (lowest, variant) =>
      lowest === null || variant.priceBdt < lowest.priceBdt ? variant : lowest,
    null,
  );

  const structuredData = productJsonLd({
    title: product.title,
    slug: product.slug,
    description: product.seoMetaDescription,
    brand: product.brand,
    imageUrl: product.images[0]?.url ?? null,
    priceBdt: cheapest?.priceBdt ?? null,
    isAvailable: pickerVariants.some(
      (variant) =>
        !variant.isClosed &&
        (variant.remaining === null || variant.remaining > 0),
    ),
    isPreorder: cheapest?.fulfillmentMode === "preorder",
    ratingAverage: rating.average,
    reviewCount: rating.count,
  });

  const breadcrumbData = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    ...breadcrumb.map((node) => ({
      name: node.name,
      path: `/categories/${node.slug}`,
    })),
    { name: product.title, path: `/products/${product.slug}` },
  ]);

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-6">
      <script
        type="application/ld+json"
        // Serialised server-side from our own data, never from user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />

      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-2 text-meta text-ink/70">
          <li>
            <Link href="/" className="hover:underline">
              Home
            </Link>
          </li>
          {breadcrumb.map((node) => (
            <li key={node.id} className="flex items-center gap-2">
              <span aria-hidden="true">/</span>
              <Link
                href={`/categories/${node.slug}`}
                className="hover:underline"
              >
                {node.name}
              </Link>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-6 grid gap-10 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="aspect-square w-full overflow-hidden rounded-card border border-blue-300 bg-blue-50">
            {product.images[0] ? (
              /* Placeholder media until the storage integration lands. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.images[0].url}
                alt={product.images[0].altText}
                className="size-full object-cover"
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex size-full items-center justify-center text-meta text-blue-400"
              >
                No photo yet
              </div>
            )}
          </div>

          {product.images.length > 1 ? (
            <ul className="flex flex-wrap gap-3">
              {product.images.slice(1).map((image) => (
                <li key={image.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt={image.altText}
                    className="size-20 rounded-card border border-blue-300 object-cover"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <div>
            {product.brand ? (
              <p className="text-meta text-ink/60">{product.brand}</p>
            ) : null}
            <h1 className="mt-1 font-display text-h1 text-ink">
              {product.title}
            </h1>
          </div>

          <VariantPicker variants={pickerVariants} />
        </div>
      </div>

      {bullets.length > 0 ? (
        <section className="mt-12 max-w-[70ch]">
          <h2 className="font-display text-h2 text-ink">What you get</h2>
          <ul className="mt-4 flex flex-col gap-2">
            {bullets.map((bullet) => (
              <li key={bullet} className="text-body text-ink/80">
                {bullet}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {product.descriptionHtml ? (
        <section className="mt-10 max-w-[70ch]">
          <h2 className="font-display text-h2 text-ink">Description</h2>
          <div
            className="mt-4 text-body text-ink/80"
            /* Authored by staff only — customers cannot create listings. */
            dangerouslySetInnerHTML={{ __html: product.descriptionHtml }}
          />
        </section>
      ) : null}

      {specs.length > 0 ? (
        <section className="mt-10">
          <h2 className="font-display text-h2 text-ink">Specifications</h2>
          {/* The manifest table, reused from the admin side */}
          <div className="mt-4 max-w-[640px] overflow-x-auto border border-blue-300">
            <table className="w-full border-collapse text-body">
              <tbody>
                {specs.map((spec, index) => (
                  <tr
                    key={spec.label}
                    className={index % 2 === 1 ? "bg-blue-200/40" : undefined}
                  >
                    <th
                      scope="row"
                      className="border-b border-blue-300 px-4 py-3 text-left text-meta font-medium text-ink/70"
                    >
                      {spec.label}
                    </th>
                    <td className="border-b border-blue-300 px-4 py-3 text-ink">
                      {spec.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <ReviewsSection
        productId={product.id}
        productSlug={product.slug}
        reviews={reviews}
        average={rating.average}
        count={rating.count}
        breakdown={breakdown}
        canReview={Boolean(eligible) && !alreadyReviewed}
        isSignedIn={Boolean(user)}
        alreadyReviewed={alreadyReviewed}
      />

      {related.length > 0 ? (
        <section className="mt-14">
          <h2 className="font-display text-h2 text-ink">Also in this category</h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {related.map((item) => (
              <ProductCard key={item.id} product={item} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
