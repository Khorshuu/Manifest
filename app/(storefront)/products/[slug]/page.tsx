import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/cache";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import {
  findCategoryPath,
  getPublicProductBySlug,
  getPublicVariants,
  listRecommendations,
  listRelatedProducts,
} from "@/lib/catalog";
import { remainingCapacity } from "@/lib/catalog/variants";
import {
  discountPercent,
  stockState,
} from "@/lib/catalog";
import type {
  ProductCompliance,
  ProductWarranty,
} from "@/db/schema";
import {
  BoxContents,
  Compliance,
  LifestyleBand,
  Warranty,
} from "./detail-sections";
import { formatArrivalWindow, formatDate } from "@/lib/format";
import { breadcrumbJsonLd, jsonLdScript } from "@/lib/seo";
import { productSchema, type SeoOffer } from "@/lib/seo/structured-data";
import { publishableKnowledge } from "@/lib/pkb/publish";
import { familyGlancePriority, listingFactRows } from "@/lib/catalog/listing-facts";
import { atAGlance } from "@/lib/seo-pulse/content-plan";
import { knowledgeLinks } from "@/lib/seo/links";
import { resolveSlugRedirect } from "@/lib/seo/redirects";
import { sanitizeRichText } from "@/lib/html/rich-text";
import { getProductRating } from "@/lib/catalog";
import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/auth/authorize";
import { productResearchStatus } from "@/lib/preparation/research-status";
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
import { cachedCategoryTree, cachedProductContent } from "@/lib/catalog/cached";

/*
 * Cache Components (DECISIONS.md D-054). The listing's own content — the
 * description, specifications, what is in the box, warranty, compliance and
 * lifestyle photography — is rendered once per product and cached
 * (CachedDetailSections below). The buy box is not: price, places left and
 * whether the window is open are read per request, as are the visitor's saved
 * items, review eligibility and recently viewed.
 */
export const instant = false;


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

/** The same bundle as cachedProductContent, read fresh, for staff previews. */
async function uncachedProductContent(slug: string) {
  const product = await getPublicProductBySlug(slug, { includeUnpublished: true });
  if (!product) return null;
  const [suggested, sameShelf, rating, reviews, breakdown] = await Promise.all([
    listRecommendations(product.id, 4),
    listRelatedProducts(product.id, product.categoryId, 8),
    getProductRating(product.id),
    listApprovedReviews(product.id),
    getRatingBreakdown(product.id),
  ]);
  return { product, suggested, sameShelf, rating, reviews, breakdown };
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/products/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const preview = await canPreview(searchParams);
  const product = preview
    ? await getPublicProductBySlug(slug, { includeUnpublished: true })
    : (await cachedProductContent(slug))?.product;

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
  /*
   * The listing, its reviews and its recommendation rows are the same for
   * every shopper and cached (D-054). A staff preview reads the database
   * directly, since a draft must never enter a shared cache. The variants —
   * live price, places left, whether the window is open — are always read per
   * request below.
   */
  const content = preview
    ? await uncachedProductContent(slug)
    : await cachedProductContent(slug);
  if (!content) {
    // An address this listing used to have still arrives (D-078, finding F5).
    const moved = await resolveSlugRedirect(slug);
    if (moved) permanentRedirect(`/products/${moved.slug}`);
    notFound();
  }
  const { product, suggested, sameShelf, rating, reviews, breakdown } = content;
  const isLive =
    (PUBLIC_STATUSES as readonly string[]).includes(product.status);

  const [variants, tree, user, serverNow] = await Promise.all([
    getPublicVariants(product.id),
    cachedCategoryTree(),
    getCurrentUser(),
    // The countdown renders from this rather than the browser clock — see
    // lib/clock.ts.
    serverInstant(),
  ]);
  // Staff only: whether what this preview shows was researched (D-119).
  const research = preview ? await productResearchStatus(user, product.id) : null;
  const glance = preview ? await glanceOf(product) : await cachedGlance(slug);

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

  /*
   * Only established facts are published (invariant I-11): the knowledge base
   * returns a brand or an identifier only when it is verified or staff-entered.
   * The links come from relationships a person accepted, so a page never
   * invents a connection between two products (D-083).
   */
  const [knowledge, links] = await Promise.all([
    publishableKnowledge(product.pkbProductId ?? null),
    knowledgeLinks(product.pkbProductId ?? null),
  ]);

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

  /*
   * The description as plain text, for structured data: the same words the
   * page renders, with the markup removed (finding F7). The meta description
   * is not used — it is written for a search result, not shown on the page.
   */
  const descriptionText = (product.descriptionHtml ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);

  const STATUS_LABELS: Record<string, string> = {
    in_stock: "In stock",
    preorder_open: "Preorder open",
    preorder_closed: "Preorder closed",
    coming_soon: "Coming soon",
    discontinued: "Discontinued",
  };
  const statusLabel = STATUS_LABELS[product.status] ?? null;

  // Built from the values rendered below, so the two cannot drift apart. The
  // cheapest option that can still be bought, as the buy box quotes it: a
  // from-price taken from an option that is full or out of stock is a price
  // nobody can pay.
  const UNAVAILABLE = new Set(["out_of_stock", "preorder_full", "closed"]);
  const lowestOf = (list: typeof pickerVariants) =>
    list.reduce<(typeof pickerVariants)[number] | null>(
      (lowest, variant) =>
        lowest === null || variant.priceBdt < lowest.priceBdt ? variant : lowest,
      null,
    );
  const cheapest =
    lowestOf(pickerVariants.filter((variant) => !UNAVAILABLE.has(variant.stockState))) ??
    lowestOf(pickerVariants);

  /*
   * Structured data is built from the values rendered above and from the
   * knowledge base, never from the meta description or an unchecked column
   * (D-080, findings F7 and F16). Each offer carries its own price and its own
   * availability, computed by the same `stockState` the buy box uses, so the
   * rich result cannot contradict the page. `cheapest` is still what the page
   * shows as the from-price.
   */
  const schemaOffers: SeoOffer[] = variants.map((variant) => {
    const picker = pickerVariants.find((entry) => entry.id === variant.id)!;
    return {
      variantId: variant.id,
      pkbVariantId: variant.pkbVariantId,
      label: variant.label,
      sku: variant.sku,
      slug: product.slug,
      priceBdt: picker.priceBdt,
      listPriceBdt: picker.listPriceBdt,
      saleEndsAt: variant.saleEndsAt,
      fulfillmentMode: variant.fulfillmentMode,
      stockState: stockState({
        fulfillmentMode: variant.fulfillmentMode,
        stockQuantity: variant.stockQuantity,
        lowStockThreshold: variant.lowStockThreshold,
        preorderCapacity: variant.preorderCapacity,
        preorderReserved: variant.preorderReserved,
        isClosed: Boolean(variant.isClosed),
      }),
      imageUrl: variant.imageUrl,
      options: variant.options.map((option) => ({ attribute: option.name, value: option.value })),
    };
  });

  const structuredData = productSchema({
    title: product.title,
    slug: product.slug,
    // The copy a shopper can actually read on the page.
    descriptionText: descriptionText || null,
    legacyBrand: product.brand,
    images: product.images.map((image) => ({ url: image.url, altText: image.altText })),
    offers: schemaOffers,
    rating: { average: rating.average, count: rating.count },
    knowledge,
    canonicalPath: null,
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
        dangerouslySetInnerHTML={{ __html: jsonLdScript(structuredData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(breadcrumbData) }}
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

      {research ? (
        <div
          role="status"
          data-research-state={research.state}
          className={`mb-6 flex flex-col gap-1 rounded-card border px-4 py-3 text-meta text-ink sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${
            research.state === "ready" ? "border-blue-300 bg-blue-50/60" : "border-brass bg-brass/10"
          }`}
        >
          <p>
            <strong>{research.label}.</strong> {research.detail}
          </p>
          {research.state === "incomplete" ? (
            <Link
              href={`/admin/products/${product.id}`}
              className="inline-flex min-h-9 shrink-0 items-center font-medium text-blue-600 underline underline-offset-2"
            >
              Continue product preparation
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* Off on a phone, where the photograph starts the page edge to edge and
          its Back button does the breadcrumb's job (D-047). The structured
          breadcrumb above is unaffected. */}
      <nav aria-label="Breadcrumb" className="hidden md:block">
        {/* One line on a phone that scrolls rather than wrapping, so a deep
            shelf does not push the photograph down. */}
        <ol className="-mx-4 flex items-center gap-2 overflow-x-auto whitespace-nowrap px-4 text-meta text-ink/70 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
          <li>
            <Link href="/" className="inline-flex min-h-6 items-center hover:underline">
              Home
            </Link>
          </li>
          {breadcrumb.map((node) => (
            <li key={node.id} className="flex items-center gap-2">
              <span aria-hidden="true">/</span>
              <Link
                href={`/categories/${node.slug}`}
                className="inline-flex min-h-6 items-center hover:underline"
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
              onlyVariantId={pickerVariants.length === 1 ? pickerVariants[0].id : null}
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
                  cheapest={
                    cheapest
                      ? {
                          priceBdt: cheapest.priceBdt,
                          listPriceBdt: cheapest.listPriceBdt,
                          discountPercent: cheapest.discountPercent,
                        }
                      : null
                  }
                  single={pickerVariants.length === 1}
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

          {/* The few facts that decide a purchase, beside the buy button:
              short label and value, for scanning (D-128). The key features —
              the same facts explained for a shopper — are further down, so
              the two never repeat each other. */}
          {glance.length > 0 ? (
            <div className="rounded-card border border-blue-300 bg-blue-50/60 p-3.5">
              <h2 className="text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-ink/70">
                At a glance
              </h2>
              {/* Label and value in two columns, for the eye to run down — not
                  the ticked lines the key features use, which made the two
                  blocks read as the same list twice. */}
              <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-meta">
                {glance.map((row) => (
                  <div key={row.label} className="contents">
                    <dt className="text-ink/70">{row.label}</dt>
                    <dd className="font-medium text-ink [overflow-wrap:anywhere]">{row.value}</dd>
                  </div>
                ))}
              </dl>
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
      {preview ? (
        <DetailSections product={product} />
      ) : (
        <CachedDetailSections slug={product.slug} />
      )}

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

      {/* Relationships the knowledge base holds: what fits this, what it
          replaced, the rest of its series. Rendered only when there are any. */}
      {links.map((group) => (
        <section key={`${group.kind}-${group.label}`} className="mt-10 flex flex-col gap-3">
          <h2 className="font-display text-lg text-ink">{group.label}</h2>
          <ul className="flex flex-wrap gap-3">
            {group.products.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/products/${item.slug}`}
                  className="inline-flex items-center gap-2 rounded-card border border-line px-3 py-2 text-meta text-ink transition-colors hover:border-brass"
                >
                  {item.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

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

type PublicProduct = NonNullable<Awaited<ReturnType<typeof getPublicProductBySlug>>>;

/**
 * The listing's content sections, shared by every shopper (D-054). Rendered
 * once per product and kept until staff change the catalogue, which saves
 * building the specification table and the description on every request.
 */
async function CachedDetailSections({ slug }: { slug: string }) {
  "use cache";
  cacheLife("minutes");
  cacheTag(CACHE_TAGS.productPages, CACHE_TAGS.listing);

  const content = await cachedProductContent(slug);
  if (!content) return null;
  cacheTag(CACHE_TAGS.product(content.product.id));
  return <DetailSections product={content.product} />;
}

/**
 * At a Glance (D-128): a few short label → value facts from the listing's own
 * established facts, the family's most important first. Cached like the
 * sections below; a staff preview reads it fresh.
 */
async function glanceOf(product: PublicProduct) {
  const [facts, priority] = await Promise.all([
    listingFactRows(product),
    familyGlancePriority(product.pkbProductId ?? null),
  ]);
  return atAGlance([...facts.specifications, ...facts.measurements], { priority });
}

async function cachedGlance(slug: string) {
  "use cache";
  cacheLife("minutes");
  cacheTag(CACHE_TAGS.productPages, CACHE_TAGS.listing);
  const content = await cachedProductContent(slug);
  if (!content) return [];
  cacheTag(CACHE_TAGS.product(content.product.id));
  return glanceOf(content.product);
}

/** The sections themselves; a staff preview renders them uncached. */
async function DetailSections({ product }: { product: PublicProduct }) {
  const bullets = Array.isArray(product.bulletFeatures)
    ? (product.bulletFeatures as string[])
    : [];
  const boxContents = Array.isArray(product.boxContents)
    ? (product.boxContents as string[])
    : [];

  const warranty = (product.warranty as ProductWarranty | null) ?? null;
  const compliance = (product.compliance as ProductCompliance | null) ?? null;

  // One assembly for the table, the measurements and At a Glance (D-128).
  const { specifications: specs, measurements } = await listingFactRows(product);

  return (
    <>
        <div className="mt-8 flex min-w-0 flex-col gap-8 md:mt-10 md:gap-10">
          <ProductInfoTabs
            // Sanitised again here for rows stored before saves were (D-057).
            descriptionHtml={product.descriptionHtml ? sanitizeRichText(product.descriptionHtml) : null}
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
    </>
  );
}
