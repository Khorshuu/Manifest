import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  breadcrumbJsonLd,
  organisationJsonLd,
  productJsonLd,
  siteUrl,
} from "@/lib/seo";

describe("urls", () => {
  it("never leaves a double slash when joining", () => {
    expect(absoluteUrl("/products/x")).toBe(`${siteUrl()}/products/x`);
    expect(absoluteUrl("products/x")).toBe(`${siteUrl()}/products/x`);
  });
});

const base = {
  title: "Studio Reference Headphones",
  slug: "studio-reference-headphones",
  description: "Open-back reference headphones.",
  brand: "Northline Audio",
  imageUrl: "/seed/headphones.svg",
  priceBdt: 31_500_00,
  isAvailable: true,
  isPreorder: true,
  ratingAverage: null,
  reviewCount: 0,
};

describe("product structured data", () => {
  it("states the price as a decimal string in BDT", () => {
    const data = productJsonLd(base) as unknown as Record<string, unknown>;
    const offers = data.offers as unknown as Record<string, unknown>;

    expect(offers.priceCurrency).toBe("BDT");
    // Stored in paisa, published in taka.
    expect(offers.price).toBe("31500.00");
  });

  /**
   * Saying InStock for something that ships in six weeks misleads a shopper
   * before they ever reach the page.
   */
  it("uses PreOrder availability for a preorder", () => {
    const data = productJsonLd(base) as unknown as Record<string, unknown>;
    const offers = data.offers as unknown as Record<string, unknown>;
    expect(offers.availability).toBe("https://schema.org/PreOrder");
  });

  it("uses InStock for stock held locally", () => {
    const data = productJsonLd({
      ...base,
      isPreorder: false,
    }) as unknown as Record<string, unknown>;
    const offers = data.offers as unknown as Record<string, unknown>;
    expect(offers.availability).toBe("https://schema.org/InStock");
  });

  it("uses SoldOut when nothing can be bought", () => {
    const data = productJsonLd({
      ...base,
      isAvailable: false,
    }) as unknown as Record<string, unknown>;
    const offers = data.offers as unknown as Record<string, unknown>;
    expect(offers.availability).toBe("https://schema.org/SoldOut");
  });

  /** An invented rating lies to shoppers and gets sites penalised. */
  it("omits the rating entirely when there are no approved reviews", () => {
    const data = productJsonLd(base);
    expect(data).not.toHaveProperty("aggregateRating");
  });

  it("includes the rating when real reviews exist", () => {
    const data = productJsonLd({
      ...base,
      ratingAverage: 4.5,
      reviewCount: 12,
    }) as unknown as Record<string, unknown>;

    const rating = data.aggregateRating as unknown as Record<string, unknown>;
    expect(rating.ratingValue).toBe(4.5);
    expect(rating.reviewCount).toBe(12);
  });

  it("omits offers when there is no price to publish", () => {
    const data = productJsonLd({ ...base, priceBdt: null });
    expect(data).not.toHaveProperty("offers");
  });

  it("makes the image an absolute URL", () => {
    const data = productJsonLd(base) as unknown as Record<string, unknown>;
    expect(String(data.image)).toBe(`${siteUrl()}/seed/headphones.svg`);
  });

  it("produces valid JSON, since it is serialised into the page", () => {
    expect(() => JSON.parse(JSON.stringify(productJsonLd(base)))).not.toThrow();
  });
});

describe("breadcrumb structured data", () => {
  it("numbers the trail from one", () => {
    const data = breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Electronics", path: "/categories/electronics" },
    ]) as unknown as Record<string, unknown>;

    const items = data.itemListElement as unknown as Record<string, unknown>[];
    expect(items[0].position).toBe(1);
    expect(items[1].position).toBe(2);
    expect(items[1].item).toBe(`${siteUrl()}/categories/electronics`);
  });
});

describe("organisation structured data", () => {
  it("says where the store delivers", () => {
    const data = organisationJsonLd() as unknown as Record<string, unknown>;
    const area = data.areaServed as unknown as Record<string, unknown>;
    expect(area.name).toBe("Bangladesh");
  });
});
