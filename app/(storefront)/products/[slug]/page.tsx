import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  findCategoryPath,
  getCategoryTree,
  getPublicProductBySlug,
  getPublicVariants,
  listRecommendations,
  listRelatedProducts,
} from "@/lib/catalog";
import { remainingCapacity } from "@/lib/catalog/variants";
import {
  discountPercent,
  formatAttributeValue,
  getAttributeDefinitionsByIds,
  stockState,
} from "@/lib/catalog";
import type {
  ProductCompliance,
  ProductDetails,
  ProductWarranty,
} from "@/db/schema";
import {
  BoxContents,
  Compliance,
  Highlights,
  LifestyleBand,
  Warranty,
  type SpecRow,
} from "./detail-sections";
import { formatArrivalWindow, formatDate } from "@/lib/format";
import { breadcrumbJsonLd, productJsonLd } from "@/lib/seo";
import { getProductRating } from "@/lib/catalog";
import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/auth/authorize";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import {
  findEligibleOrderItem,
  getRatingBreakdown,
  hasReviewed,
  listApprovedReviews,
} from "@/lib/reviews";
import { Gallery } from "./gallery";
import { LivePrice } from "./live-price";
import { PhotoActions } from "./photo-actions";
import { ProductInfoTabs } from "./info-tabs";
import { Journey } from "@/components/journey";
import { RecommendationSection } from "@/components/recommendation-section";
import { ReviewsSection } from "./reviews-section";
import { VariantPicker, type PickerVariant } from "./variant-picker";
import { cookies } from "next/headers";
import { RecentlyViewedTracker } from "@/components/recently-viewed-tracker";
import { listSavedVariantIds } from "@/lib/account";
import {
  parseRecentlyViewed,
  RECENTLY_VIEWED_COOKIE,
} from "@/lib/account/recently-viewed";
import { listProductCardsByIds } from "@/lib/catalog/storefront";
import { serverInstant } from "@/lib/clock";

export const dynamic = "force-dynamic";

/**
 * Staff preview: `?preview=1` lets someone with catalogue access see a draft
 * exactly as it will look. Anyone else asking for it gets the public page (or
 * "not found"), so the flag cannot expose an unpublished listing.
 */
async function canPreview(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
): Promise<boolean> {
  const query = await searchParams;
  if (query.preview !== "1") return false;
  return can(await getCurrentUser(), "catalog.manage");
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/products/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const preview = await canPreview(searchParams);
  const product = await getPublicProductBySlug(slug, { includeUnpublished: preview });

  if (!product) return { title: "Product not found" };

  if (preview) {
    return { title: `Preview: ${product.title}`, robots: { index: false, follow: false } };
  }

  return {
    title: product.seoMetaTitle ?? product.title,
    description: product.seoMetaDescription ?? undefined,
    // A custom canonical wins where staff set one; otherwise the product own
    // address, which is right for all but syndicated listings.
    alternates: {
      canonical: product.canonicalUrl ?? `/products/${product.slug}`,
    },
    // Staff can keep a listing out of search without unpublishing it.
    robots: product.seoNoIndex ? { index: false, follow: true } : undefined,
  };
}

export default async function ProductPage({
  params,
  searchParams,
}: PageProps<"/products/[slug]">) {
  const { slug } = await params;
  const preview = await canPreview(searchParams);
  const product = await getPublicProductBySlug(slug, { includeUnpublished: preview });
  if (!product) notFound();
  const isLive =
    (PUBLIC_STATUSES as readonly string[]).includes(product.status);

  const [
    variants,
    tree,
    suggested,
    sameShelf,
    rating,
    reviews,
    breakdown,
    user,
    serverNow,
  ] = await Promise.all([
    getPublicVariants(product.id),
    getCategoryTree(),
    // Scored against what the catalogue records about both products — see
    // lib/catalog/recommendations.ts. Never a random draw.
    listRecommendations(product.id, 4),
    // Deliberately more than the row shows: whatever the recommendations
    // already used is dropped below, and a short row would otherwise appear
    // for a well-stocked shelf.
    listRelatedProducts(product.id, product.categoryId, 8),
    getProductRating(product.id),
    listApprovedReviews(product.id),
    getRatingBreakdown(product.id),
    getCurrentUser(),
    // The countdown renders from this rather than the browser clock — see
    // lib/clock.ts.
    serverInstant(),
  ]);

  /*
   * A product recommended above is not shown again immediately below it. The
   * two rows answer different questions — "what else is like this" and "what
   * else is on this shelf" — and the same four cards under both headings makes
   * the page look as though one of them failed.
   */
  const suggestedIds = new Set(suggested.map((item) => item.id));
  const remainingOnShelf = sameShelf
    .filter((item) => !suggestedIds.has(item.id))
    .slice(0, 4);

  // Both decided on the server: the form is only rendered for someone whose
  // delivered order entitles them to it, and submitting re-checks the same
  // thing rather than trusting the page.
  const [eligible, alreadyReviewed] = user
    ? await Promise.all([
        findEligibleOrderItem(user.id, product.id),
        hasReviewed(user.id, product.id),
      ])
    : [null, false];

  const [savedVariantIds, recentlyViewed] = await Promise.all([
    user
      ? listSavedVariantIds(
          user.id,
          variants.map((variant) => variant.id),
        )
      : Promise.resolve([]),
    // The cookie holds ids only; each is resolved through the public
    // predicate, and this product itself is left out.
    cookies().then((store) =>
      listProductCardsByIds(
        parseRecentlyViewed(store.get(RECENTLY_VIEWED_COOKIE)?.value)
          .filter((id) => id !== product.id)
          .slice(0, 4),
      ),
    ),
  ]);

  const breadcrumb = findCategoryPath(tree, product.categoryId);

  // Availability and dates are settled before render — the window state comes
  // from the database, so there is one clock rather than one per process.
  const pickerVariants: PickerVariant[] = variants.map((variant) => ({
    id: variant.id,
    label: variant.label,
    imageUrl: variant.imageUrl,
    // Already the charged price: getPublicVariants resolves the sale window
    // in SQL, so the page cannot disagree with the cart about it.
    priceBdt: variant.priceBdt,
    listPriceBdt: variant.listPriceBdt,
    discountPercent: discountPercent(
      {
        priceBdt: variant.listPriceBdt,
        salePriceBdt: variant.salePriceBdt,
        saleStartsAt: null,
        saleEndsAt: variant.saleEndsAt,
      },
      new Date(serverNow),
    ),
    saleEndsLabel: variant.saleEndsAt ? formatDate(variant.saleEndsAt) : null,
    stockState: stockState({
      fulfillmentMode: variant.fulfillmentMode,
      stockQuantity: variant.stockQuantity,
      lowStockThreshold: variant.lowStockThreshold,
      preorderCapacity: variant.preorderCapacity,
      preorderReserved: variant.preorderReserved,
      isClosed: Boolean(variant.isClosed),
    }),
    fulfillmentMode: variant.fulfillmentMode,
    remaining:
      variant.fulfillmentMode === "preorder"
        ? remainingCapacity(variant)
        : variant.stockQuantity,
    capacity:
      variant.fulfillmentMode === "preorder" ? variant.preorderCapacity : null,
    isClosed: Boolean(variant.isClosed),
    closesAtLabel: variant.preorderClosesAt
      ? formatDate(variant.preorderClosesAt)
      : null,
    closesAtIso: variant.preorderClosesAt
      ? variant.preorderClosesAt.toISOString()
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
  const boxContents = Array.isArray(product.boxContents)
    ? (product.boxContents as string[])
    : [];
  /*
   * Two lines under the name on a phone: the first key feature, or the start
   * of the description as plain text — the same source the catalogue card's
   * one-liner uses.
   */
  const summarySource =
    bullets.find((line) => line.trim() !== "") ??
    (product.descriptionHtml
      ? product.descriptionHtml
          .replace(/<[^>]*>/g, " ")
          .replace(/&[a-z]+;/gi, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "");
  const summary = summarySource || null;

  const STATUS_LABELS: Record<string, string> = {
    in_stock: "In stock",
    preorder_open: "Preorder open",
    preorder_closed: "Preorder closed",
    coming_soon: "Coming soon",
    discontinued: "Discontinued",
  };
  const statusLabel = STATUS_LABELS[product.status] ?? null;

  const warranty = (product.warranty as ProductWarranty | null) ?? null;
  const compliance = (product.compliance as ProductCompliance | null) ?? null;
  const details = (product.details as ProductDetails | null) ?? null;

  /*
   * The specifications table, assembled from four sources in the order a
   * shopper reads them: the facts every listing has, then what the category
   * asks of its products, then the advanced block, then anything typed by
   * hand. Every row here has a value — a blank is dropped rather than shown
   * as a dash, which is what keeps the table honest on a thin listing.
   */
  const storedAttributes =
    (product.attributeValues as Record<string, string | string[]> | null) ?? {};
  const attributeDefinitions = await getAttributeDefinitionsByIds(
    Object.keys(storedAttributes),
  );

  /*
   * Two lists, not one. Anything measurable goes to the Measurements tab and
   * the rest to Specification, so neither tab repeats the other (D-043).
   */
  const DETAIL_LABELS: [keyof ProductDetails, string][] = [
    ["manufacturer", "Manufacturer"],
    ["modelName", "Model"],
    ["modelNumber", "Model number"],
    ["manufacturerPartNumber", "Part number"],
    ["material", "Material"],
    ["color", "Colour"],
    ["compatibility", "Compatibility"],
    ["specialFeatures", "Special features"],
    ["intendedUse", "Intended use"],
    ["careInstructions", "Care instructions"],
    ["releaseDate", "Released"],
  ];

  const MEASUREMENT_LABELS: [keyof ProductDetails, string][] = [
    ["size", "Size"],
    ["dimensions", "Product dimensions"],
    ["itemWeight", "Item weight"],
    ["packageDimensions", "Package dimensions"],
    ["packageWeight", "Package weight"],
    ["unitCount", "Unit count"],
    ["unitType", "Unit type"],
  ];

  const specs: SpecRow[] = [
    ...(product.brand ? [{ label: "Brand", value: product.brand }] : []),
    ...attributeDefinitions
      .map((definition) => {
        const value = storedAttributes[definition.id];
        return value === undefined
          ? null
          : {
              label: definition.name,
              value: formatAttributeValue(definition, value),
            };
      })
      .filter((row): row is SpecRow => row !== null),
    ...(details
      ? DETAIL_LABELS.map(([key, label]) => {
          const value = details[key];
          return value ? { label, value: String(value) } : null;
        }).filter((row): row is SpecRow => row !== null)
      : []),
    ...(Array.isArray(product.specTable)
      ? (product.specTable as SpecRow[]).filter(
          (row) => row.label?.trim() && row.value?.trim(),
        )
      : []),
    ...(compliance?.countryOfOrigin
      ? [{ label: "Country of origin", value: compliance.countryOfOrigin }]
      : []),
    ...(product.identifierValue && product.identifierType
      ? [
          {
            label: product.identifierType.toUpperCase(),
            value: product.identifierValue,
          },
        ]
      : []),
  ];

  /*
   * Measurements come only from what staff recorded — the measurement rows on
   * the listing and the measurable fields of the advanced block. Nothing is
   * derived or estimated, so the tab is absent on a listing that has none
   * rather than showing a table of guesses.
   */
  const measurements: SpecRow[] = [
    ...(Array.isArray(product.measurements)
      ? (product.measurements as SpecRow[]).filter(
          (row) => row.label?.trim() && row.value?.trim(),
        )
      : []),
    ...(details
      ? MEASUREMENT_LABELS.map(([key, label]) => {
          const value = details[key];
          return value ? { label, value: String(value) } : null;
        }).filter((row): row is SpecRow => row !== null)
      : []),
  ];

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
    <div className="mx-auto w-full max-w-[1280px] px-4 pb-8 pt-0 md:px-6 md:pt-8">
      <script
        type="application/ld+json"
        // Serialised server-side from our own data, never from user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />

      {preview && !isLive ? (
        <p
          role="status"
          className="mb-6 rounded-card border border-brass bg-brass/10 px-4 py-3 text-meta text-ink"
        >
          <strong>Preview — not visible to customers.</strong> This product is{" "}
          {product.status === "archived" ? "archived" : "a draft"}. Publish it from the admin to
          put it on sale.
        </p>
      ) : null}

      {/* Off on a phone, where the photograph starts the page edge to edge and
          its Back button does the breadcrumb's job (D-047). The structured
          breadcrumb above is unaffected. */}
      <nav aria-label="Breadcrumb" className="hidden md:block">
        {/* One line on a phone that scrolls rather than wrapping, so a deep
            shelf does not push the photograph down. */}
        <ol className="-mx-4 flex items-center gap-2 overflow-x-auto whitespace-nowrap px-4 text-meta text-ink/70 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
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

      <div className="grid gap-4 md:mt-4 md:gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-10">
        <Gallery
          title={product.title}
          slug={product.slug}
          videoUrl={product.videoUrl}
          overlay={
            <PhotoActions
              title={product.title}
              backHref={
                breadcrumb.at(-1)
                  ? `/categories/${breadcrumb.at(-1)!.slug}`
                  : "/search"
              }
              variantIds={pickerVariants.map((variant) => variant.id)}
              savedVariantIds={savedVariantIds}
              signedIn={Boolean(user)}
              returnTo={`/products/${product.slug}`}
            />
          }
          images={product.images.map((image) => ({
            id: image.id,
            url: image.url,
            altText: image.altText,
          }))}
        />

        <div className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          <div>
            {/* The phone's heading, after the owner's reference (D-047): a
                small status pill, the name with its price beside it, and two
                lines saying what the thing is. A desktop keeps the price in
                the buy box and none of the rest. */}
            {statusLabel ? (
              <p className="mb-2 w-fit rounded-full bg-blue-50 px-2.5 py-1 text-[0.6875rem] font-semibold text-ink/80 lg:hidden">
                {statusLabel}
              </p>
            ) : null}
            {product.brand ? (
              <p className="text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-ink/70">
                {product.brand}
              </p>
            ) : null}
            <div className="flex items-start justify-between gap-3">
              <h1 className="mt-0.5 min-w-0 text-[1.1875rem] font-bold leading-snug tracking-[-0.01em] text-ink sm:text-[1.375rem] sm:leading-tight md:mt-1 md:text-[1.625rem]">
                {product.title}
              </h1>
              <div className="pt-1 lg:hidden">
                <LivePrice
                  variants={pickerVariants.map((variant) => ({
                    id: variant.id,
                    priceBdt: variant.priceBdt,
                    listPriceBdt: variant.listPriceBdt,
                    discountPercent: variant.discountPercent,
                  }))}
                />
              </div>
            </div>
            {summary ? (
              <p className="mt-1.5 line-clamp-2 text-meta text-ink/70 lg:hidden">
                {summary}
              </p>
            ) : null}
            {rating.count > 0 ? (
              <a href="#reviews" className="mt-1 inline-block text-meta text-blue-600 hover:underline">
                {rating.average} out of 5 · {rating.count} review{rating.count === 1 ? "" : "s"}
              </a>
            ) : null}
          </div>

          <VariantPicker
            variants={pickerVariants}
            serverNow={serverNow}
            signedIn={Boolean(user)}
            savedVariantIds={savedVariantIds}
            returnTo={`/products/${product.slug}`}
          />
          <RecentlyViewedTracker productId={product.id} />

          {/* The three or four claims that decide a purchase, beside the buy
              button rather than below the fold. The full list, if it is
              longer, is still under Key features further down. */}
          {bullets.length > 0 ? (
            <div className="rounded-card border border-blue-300 bg-blue-50/60 p-3.5">
              <h2 className="text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-ink/70">
                At a glance
              </h2>
              <div className="mt-2 text-meta">
                <Highlights items={bullets.slice(0, 4)} />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/*
       * Two columns, each with its own contents — not sections dropped into a
       * grid, which is what this was. In that arrangement the description
       * landed in the narrow right column and the specifications wrapped to a
       * second row, leaving most of the right-hand side of the page blank.
       *
       * Every section below renders nothing at all when it has nothing to
       * say, so a thin listing reads as short rather than as unfinished.
       */}
      {/*
       * Description, Specification and — only when the listing has any —
       * Measurements, as one tabbed panel rather than three headings stacked
       * down the page (D-043). Everything below it is a different kind of
       * promise (what is in the box, the warranty, safety) and stays its own
       * section, each still rendering nothing when it has nothing to say.
       */}
      <div className="mt-8 flex min-w-0 flex-col gap-8 md:mt-10 md:gap-10">
        <ProductInfoTabs
          descriptionHtml={product.descriptionHtml}
          keyFeatures={bullets}
          specifications={specs}
          measurements={measurements}
        />

        <BoxContents items={boxContents} />

        <Warranty warranty={warranty} />

        <Compliance compliance={compliance} />
      </div>

      <div className="mt-12">
        <LifestyleBand
          title={product.title}
          images={product.lifestyleImages.map((image) => ({
            id: image.id,
            url: image.url,
            altText: image.altText,
          }))}
        />
      </div>

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

      <RecommendationSection
        eyebrow="Chosen for this listing"
        title="More like this"
        products={suggested}
      />

      <RecommendationSection
        eyebrow="Same shelf"
        title="Also in this category"
        products={remainingOnShelf}
        link={
          breadcrumb.at(-1)
            ? {
                href: `/categories/${breadcrumb.at(-1)!.slug}`,
                label: `Everything in ${breadcrumb.at(-1)!.name}`,
              }
            : undefined
        }
      />

      <RecommendationSection
        eyebrow="Your history"
        title="Recently viewed"
        products={recentlyViewed}
      />

      {/* The route a batch travels, at the very foot of the page: it explains
          the shop rather than this product, so it comes after everything a
          shopper needs to decide. */}
      <Journey
        closesAt={variants[0]?.preorderClosesAt ?? null}
        arrivesFrom={variants[0]?.estimatedArrivalFrom ?? null}
        arrivesTo={variants[0]?.estimatedArrivalTo ?? null}
      />
    </div>
  );
}
