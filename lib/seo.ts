/**
 * SEO helpers.
 *
 * Structured data is generated from the same values rendered on the page, so
 * the two cannot drift — a rich result that contradicts the page is worse
 * than none at all.
 */

/** The site's public origin, without a trailing slash. */
export function siteUrl(): string {
  const configured = process.env.SITE_URL ?? "http://localhost:3000";
  return configured.replace(/\/$/, "");
}

export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export type ProductJsonLdInput = {
  title: string;
  slug: string;
  description: string | null;
  brand: string | null;
  imageUrl: string | null;
  priceBdt: number | null;
  /** Whether a shopper can buy it right now. */
  isAvailable: boolean;
  isPreorder: boolean;
  ratingAverage: number | null;
  reviewCount: number;
};

/**
 * Product structured data.
 *
 * Availability uses PreOrder where that is what it is, because saying InStock
 * for something that ships in six weeks misleads the shopper before they ever
 * reach the page.
 */
export function productJsonLd(product: ProductJsonLdInput) {
  const availability = !product.isAvailable
    ? "https://schema.org/SoldOut"
    : product.isPreorder
      ? "https://schema.org/PreOrder"
      : "https://schema.org/InStock";

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    url: absoluteUrl(`/products/${product.slug}`),
  };

  if (product.description) data.description = product.description;
  if (product.brand) data.brand = { "@type": "Brand", name: product.brand };
  if (product.imageUrl) data.image = absoluteUrl(product.imageUrl);

  if (product.priceBdt !== null) {
    data.offers = {
      "@type": "Offer",
      priceCurrency: "BDT",
      // Schema.org expects a decimal string, and the price is stored in paisa.
      price: (product.priceBdt / 100).toFixed(2),
      availability,
      url: absoluteUrl(`/products/${product.slug}`),
    };
  }

  // Only when there are real approved reviews: an invented rating is exactly
  // the kind of thing that gets a site penalised, and it lies to shoppers.
  if (product.reviewCount > 0 && product.ratingAverage !== null) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: product.ratingAverage,
      reviewCount: product.reviewCount,
    };
  }

  return data;
}

export function breadcrumbJsonLd(
  trail: { name: string; path: string }[],
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path),
    })),
  };
}

export function organisationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    name: "Manifest",
    url: siteUrl(),
    description:
      "Niche American products sourced to order and delivered in Bangladesh, at a fixed landed price.",
    areaServed: { "@type": "Country", name: "Bangladesh" },
  };
}
