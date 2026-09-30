import type { StockState } from "@/lib/catalog/price";
import type { PublishableKnowledge } from "@/lib/pkb/publish";
import { identifiersFor } from "@/lib/pkb/publish";
import { valueWithUnit } from "@/lib/pkb/unit-text";
import { absoluteUrl } from "./index";

/**
 * Product structured data (D-080, findings F7 and F16).
 *
 * Three rules hold this file together.
 *
 *  1. **Everything comes from data the page itself shows.** The description is
 *     the visible product copy, not the meta description a shopper never sees.
 *     The prices, the availability and the number of places left are the same
 *     values the buy box renders, computed by the same rules — a rich result
 *     that contradicts the page is worse than no rich result.
 *  2. **Facts come from the knowledge base, and only established ones.** Brand
 *     and identifiers are read through `publishableKnowledge`, which returns a
 *     value only when it is VERIFIED or staff-entered. Nothing is invented: no
 *     rating without approved reviews, no GTIN without a checked one, no
 *     shipping or return policy unless the shop has published one.
 *  3. **A product with variants is a ProductGroup.** Each offer is its own
 *     Offer with its own price, availability and identifiers, so a shopper
 *     searching for the 512 GB model is not shown the 256 GB price.
 */

export type SeoOffer = {
  variantId: string;
  pkbVariantId: string | null;
  label: string;
  sku: string | null;
  slug: string;
  /** The price charged today, in paisa. */
  priceBdt: number;
  listPriceBdt: number | null;
  saleEndsAt: Date | null;
  fulfillmentMode: string;
  /** From `stockState`, so the schema and the buy box agree. */
  stockState: StockState;
  imageUrl: string | null;
  /** Variant-defining option values, for `ProductGroup.variesBy` and the offer name. */
  options: { attribute: string; value: string }[];
};

export type ProductSchemaInput = {
  title: string;
  slug: string;
  /** Visible product copy as plain text, already stripped of markup. */
  descriptionText: string | null;
  /** The listing's own brand text; used only when the knowledge base has none. */
  legacyBrand: string | null;
  images: { url: string; altText: string }[];
  offers: SeoOffer[];
  rating: { average: number | null; count: number };
  knowledge: PublishableKnowledge;
  /** A canonical the staff set, already validated as this site's own. */
  canonicalPath: string | null;
  currency?: string;
};

const AVAILABILITY: Record<StockState, string> = {
  in_stock: "https://schema.org/InStock",
  low_stock: "https://schema.org/LimitedAvailability",
  out_of_stock: "https://schema.org/OutOfStock",
  preorder: "https://schema.org/PreOrder",
  preorder_full: "https://schema.org/SoldOut",
  // Announced but not yet sellable: schema.org has a term for exactly that.
  coming_soon: "https://schema.org/PreOrder",
  closed: "https://schema.org/SoldOut",
};

function paisaToDecimal(value: number): string {
  return (value / 100).toFixed(2);
}

/** A price is only valid while the sale that set it is, so the sale end is carried through. */
function priceValidUntil(offer: SeoOffer): string | undefined {
  if (!offer.saleEndsAt) return undefined;
  return offer.saleEndsAt.toISOString().slice(0, 10);
}

function offerSchema(input: ProductSchemaInput, offer: SeoOffer, url: string): Record<string, unknown> {
  const identifiers = identifiersFor(input.knowledge, offer.pkbVariantId);
  const data: Record<string, unknown> = {
    "@type": "Offer",
    url,
    priceCurrency: input.currency ?? "BDT",
    price: paisaToDecimal(offer.priceBdt),
    availability: AVAILABILITY[offer.stockState],
    // Manifest sells one landed price to one country; saying so is a fact.
    eligibleRegion: { "@type": "Country", name: "Bangladesh" },
    itemCondition: "https://schema.org/NewCondition",
  };
  const until = priceValidUntil(offer);
  if (until) data.priceValidUntil = until;
  if (offer.sku) data.sku = offer.sku;
  if (identifiers.gtin) data.gtin = identifiers.gtin;
  if (identifiers.mpn) data.mpn = identifiers.mpn;
  if (offer.options.length > 0) data.name = offer.label;
  return data;
}

/**
 * The product's own properties, from established knowledge only. Anything the
 * knowledge base maps to a schema.org property is emitted as that property;
 * the rest are `additionalProperty`, which is what schema.org asks for.
 */
function knowledgeProperties(knowledge: PublishableKnowledge): {
  direct: Record<string, unknown>;
  additional: Record<string, unknown>[];
} {
  const direct: Record<string, unknown> = {};
  const additional: Record<string, unknown>[] = [];
  for (const property of knowledge.properties) {
    if (property.pkbVariantId !== null) continue;
    const value = valueWithUnit(property.value, property.unit);
    if (property.property.startsWith("additionalProperty")) {
      additional.push({ "@type": "PropertyValue", name: property.label, value });
      continue;
    }
    // One value per property: the first established one wins, and a repeated
    // property becomes an additionalProperty rather than overwriting.
    if (direct[property.property] === undefined) direct[property.property] = value;
    else additional.push({ "@type": "PropertyValue", name: property.label, value });
  }
  return { direct, additional };
}

/**
 * Product or ProductGroup JSON-LD for one listing.
 *
 * With no sellable offer the listing is still described — a "coming soon" page
 * is a real page — but no `offers` is emitted, because there is no price to
 * state.
 */
export function productSchema(input: ProductSchemaInput): Record<string, unknown> {
  const url = absoluteUrl(input.canonicalPath ?? `/products/${input.slug}`);
  const brand = input.knowledge.brand ?? input.legacyBrand;
  const { direct, additional } = knowledgeProperties(input.knowledge);
  const productIdentifiers = identifiersFor(input.knowledge, null);
  const varying = [...new Set(input.offers.flatMap((offer) => offer.options.map((option) => option.attribute)))];
  const isGroup = input.offers.length > 1 && varying.length > 0;

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": isGroup ? "ProductGroup" : "Product",
    name: input.title,
    url,
    ...direct,
  };

  if (input.descriptionText) data.description = input.descriptionText;
  if (brand) data.brand = { "@type": "Brand", name: brand };
  if (input.images.length > 0) data.image = input.images.map((image) => absoluteUrl(image.url));
  if (productIdentifiers.gtin) data.gtin = productIdentifiers.gtin;
  if (productIdentifiers.mpn) data.mpn = productIdentifiers.mpn;
  if (additional.length > 0) data.additionalProperty = additional;

  if (isGroup) {
    data.productGroupID = input.slug;
    data.variesBy = varying;
    data.hasVariant = input.offers.map((offer) => {
      const identifiers = identifiersFor(input.knowledge, offer.pkbVariantId);
      const variant: Record<string, unknown> = {
        "@type": "Product",
        name: `${input.title} — ${offer.label}`,
        url: `${url}?variant=${offer.variantId}`,
        offers: offerSchema(input, offer, `${url}?variant=${offer.variantId}`),
      };
      if (offer.sku) variant.sku = offer.sku;
      if (identifiers.gtin) variant.gtin = identifiers.gtin;
      if (identifiers.mpn) variant.mpn = identifiers.mpn;
      if (offer.imageUrl) variant.image = absoluteUrl(offer.imageUrl);
      for (const option of offer.options) {
        // Only the properties schema.org names; anything else stays additional.
        const key = option.attribute.toLowerCase();
        if (key === "color" || key === "colour") variant.color = option.value;
        else if (key === "size") variant.size = option.value;
        else if (key === "material") variant.material = option.value;
        else {
          const existing = Array.isArray(variant.additionalProperty) ? (variant.additionalProperty as unknown[]) : [];
          variant.additionalProperty = [...existing, { "@type": "PropertyValue", name: option.attribute, value: option.value }];
        }
      }
      const properties = input.knowledge.properties.filter((row) => row.pkbVariantId === offer.pkbVariantId);
      for (const property of properties) {
        const value = valueWithUnit(property.value, property.unit);
        if (variant[property.property] === undefined && !property.property.startsWith("additionalProperty")) {
          variant[property.property] = value;
        }
      }
      return variant;
    });
  } else if (input.offers.length === 1) {
    data.offers = offerSchema(input, input.offers[0], url);
    if (input.offers[0].sku) data.sku = input.offers[0].sku;
  } else if (input.offers.length > 1) {
    // Several offers that do not differ by an option: an AggregateOffer states
    // the range without pretending one price covers them all.
    const prices = input.offers.map((offer) => offer.priceBdt);
    data.offers = {
      "@type": "AggregateOffer",
      priceCurrency: input.currency ?? "BDT",
      lowPrice: paisaToDecimal(Math.min(...prices)),
      highPrice: paisaToDecimal(Math.max(...prices)),
      offerCount: input.offers.length,
      availability: AVAILABILITY[bestState(input.offers)],
      url,
    };
  }

  // Only real, approved reviews. An invented rating is both a lie to shoppers
  // and the fastest way to lose rich results altogether.
  if (input.rating.count > 0 && input.rating.average !== null) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: input.rating.average,
      reviewCount: input.rating.count,
      bestRating: 5,
      worstRating: 1,
    };
  }

  return data;
}

/** The most available state among several offers — what the page effectively offers. */
function bestState(offers: SeoOffer[]): SeoOffer["stockState"] {
  const order: StockState[] = ["in_stock", "low_stock", "preorder", "coming_soon", "preorder_full", "out_of_stock", "closed"];
  for (const state of order) {
    if (offers.some((offer) => offer.stockState === state)) return state;
  }
  return "out_of_stock";
}

/** A category page as an ItemList of the products it shows, in the order shown. */
export function categorySchema(input: {
  name: string;
  path: string;
  description: string | null;
  products: { title: string; slug: string }[];
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: input.name,
    url: absoluteUrl(input.path),
  };
  if (input.description) data.description = input.description;
  if (input.products.length > 0) {
    data.mainEntity = {
      "@type": "ItemList",
      numberOfItems: input.products.length,
      itemListElement: input.products.map((product, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: absoluteUrl(`/products/${product.slug}`),
        name: product.title,
      })),
    };
  }
  return data;
}
