/**
 * What a manufacturer's own shop page has to be readable as (D-119).
 *
 * Found by preparing a Glorious Model O against gloriousgaming.com: a Shopify
 * product page with its identifiers on the Offer rather than the Product,
 * feature cards built from an icon, a title and a paragraph, and a great deal
 * of furniture — navigation, reviews, a newsletter pop-up, a "perfect
 * pairing" banner selling a mouse pad — each built from the same headings and
 * rows the specification readers exist to read. Nothing here reaches the
 * network; the page's shapes are reproduced as fixtures, and none of the
 * rules below names a manufacturer.
 */
import { describe, expect, it } from "vitest";
import { encodingProblem } from "@/db/encoding";
import { describeDatabaseError, isEncodingDatabaseError, isPermanentDatabaseError, isTransientDatabaseError } from "@/lib/db-errors";
import { enrichmentFailure, identityVerdict, modelLikeSkus, SourceStorageError } from "@/lib/pkb/enrichment";
import { extractHtml } from "@/lib/pkb/extract";
import { identityLabelKind, isIdentityLabel, isIdentityLine } from "@/lib/pkb/identity-labels";
import { cleanText, listItems, removeStorageNoise, removeStorageNoiseDeep } from "@/lib/pkb/normalize";
import { EMPTY_GROUNDED, type GroundedKnowledge } from "@/lib/pkb/publish";
import type { ProductIdentity } from "@/lib/pkb/resolution";
import { describeResearchStatus } from "@/lib/preparation/presentation";
import { identityComparison } from "@/lib/preparation/runner";
import { knowledgeSufficiency } from "@/lib/seo-pulse/facts";
import { generateByRules } from "@/lib/seo-pulse/rules";
import type { SeoPulseInput } from "@/lib/seo-pulse/types";

// ---------------------------------------------------------------- fixtures

const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Model O Classic Wireless Mouse",
  brand: { "@type": "Brand", name: "Glorious" },
  description: "Ultralight​ wireless gaming mouse.",
  offers: [
    {
      "@type": "Offer",
      sku: "GLO-OC-WL-BLK",
      gtin12: "840408304115",
      price: "79.99",
      priceCurrency: "USD",
    },
  ],
});

/** A second, unrelated product the same page declares — a cross-sell. */
const CROSS_SELL_JSON_LD = JSON.stringify({
  "@type": "Product",
  name: "GMP 2 Gaming Mouse Pad",
  offers: { "@type": "AggregateOffer", offers: [{ "@type": "Offer", sku: "GMP2-XL", gtin13: "0840408300001" }] },
});

const SHOP_PAGE = `<!doctype html><html><head>
<title>Model O Classic Wireless Mouse</title>
<script type="application/ld+json">${JSON_LD}</script>
<script type="application/ld+json">${CROSS_SELL_JSON_LD}</script>
</head><body>
<nav class="nav-desktop"><div class="row"><div>Mice</div><div>Keyboards</div></div></nav>
<div x-data="navMobile"><div id="menu-store">{"title":"Mice","url":"/collections/mice","children":[]}</div></div>

<section class="product-hero">
  <h1>Model O Classic Wireless Mouse</h1>
  <form action="/cart/add"><select name="id"><option>Black</option></select><button type="submit">Add to Cart</button></form>
</section>

<div role="tabpanel" id="product-tab-panel-0">
  <div class="swiper-wrapper">
    <div class="swiper-slide"><div class="card border-lime">
      <div class="flex"><div class="icon"><img src="/icon-wireless.webp" alt=""></div></div>
      <div class="pb-4 font-semibold">Gaming Grade 2.4GHz Wireless</div>
      <p class="text-base">Low-latency​ wireless tuned for competitive play, with a range of up to ten metres.</p>
    </div></div>
    <div class="swiper-slide"><div class="card border-sapphire">
      <div class="flex"><div class="icon"><img src="/icon-weight.webp" alt=""></div></div>
      <div class="pb-4 font-semibold">Ultralight Weight</div>
      <p class="text-base">At just 69g, the Model O Classic delivers speed and precision with a durable honeycomb shell.</p>
    </div></div>
  </div>
</div>

<div role="tabpanel" id="product-tab-panel-1">
  <h2>Tech Specs</h2>
  <table><tbody>
    <tr><th scope="row">Warranty</th><td>2 years</td></tr>
    <tr><th scope="row">Weight</th><td>69g</td></tr>
    <tr><th scope="row">Max Sensitivity (DPI)</th><td>19,000 DPI</td></tr>
    <tr><th scope="row">Included</th><td>• 1× USB Receiver • 1× USB-A to USB-C Cable</td></tr>
  </tbody></table>
</div>

<div class="feature-row">
  <h3>6 Remappable Buttons</h3>
  <p>Map your go-to abilities and shortcuts exactly where they feel right.</p>
</div>
<div class="quote"><div>Model O Classic gives you the precision and durability to stay on top—while</div><div>everyone else gets sent back to lobby.</div></div>

<div class="hero-bg-with-text__layer">
  <div class="hero-bg-with-text__content">
    <div>PERFECT PAIRING</div>
    <h2>GMP 2 Gaming Mouse Pad</h2>
    <p>Aim for success with a precision, spill-resistant gaming surface.</p>
  </div>
  <div class="cta"><a href="/products/gmp-2">Shop Now</a></div>
</div>

<div class="product-reviews">
  <div class="review"><div>Nathan k.</div><div>5/5</div></div>
  <div class="review-card"><div class="name">Sam R.</div><p>Best mouse I have owned, light and quick.</p><div>★★★★★</div></div>
</div>
<div class="klaviyo-newsletter-popup"><div class="row"><div>You're on the List!</div><div>Close</div></div></div>
<div class="row"><div>Model O Classic</div><div>Add to Cart</div></div>
<footer><div class="row"><div>Support</div><div>Contact us</div></div></footer>
<div id="accessibly-config" style="display:none">{"themeColor":"#4b43ab","showLogo":true}</div>
</body></html>`;

const pairsOf = (html: string) => extractHtml(html).pairs;
const labelsOf = (html: string) => pairsOf(html).map((pair) => pair.label);

// ------------------------------------------------------ 1–3 sanitisation

describe("text a page leaves behind that a database cannot keep", () => {
  it("removes U+200B, the zero-width space an editor leaves in copy", () => {
    expect(removeStorageNoise("Ultralight​weight")).toBe("Ultralightweight");
    expect(cleanText("  Low-latency​ wireless ")).toBe("Low-latency wireless");
  });

  it("removes NUL and the other C0 controls, but not tab or line breaks", () => {
    expect(removeStorageNoise("a\u0000b\u0007c")).toBe("abc");
    expect(removeStorageNoise("a\tb\nc\r\nd")).toBe("a\tb\nc\r\nd");
  });

  it("removes the byte-order mark, the soft hyphen and the word joiner", () => {
    expect(removeStorageNoise("﻿Sen­sor⁠")).toBe("Sensor");
  });

  it("keeps every visible character: accents, units, symbols, other scripts, emoji", () => {
    const visible = "Café — 48 Ω, −20 °C, 1× receiver, µm, 日本語, العربية, 👍🏽, 👨‍👩‍👧";
    expect(removeStorageNoise(visible)).toBe(visible);
    expect(cleanText(visible)).toBe(visible);
  });

  it("keeps the joiners that shape Persian and hold emoji together", () => {
    expect(removeStorageNoise("می‌خواهم")).toBe("می‌خواهم");
    expect(removeStorageNoise("👨‍👩")).toBe("👨‍👩");
  });

  it("cleans escaped noise inside structured data, keys included", () => {
    const parsed = JSON.parse('{"na\\u200Bme":"Model\\u0000 O","list":["a\\u200Bb"]}');
    expect(removeStorageNoiseDeep(parsed)).toEqual({ name: "Model O", list: ["ab"] });
  });

  it("stores the page's text and structured data without the noise", () => {
    const extraction = extractHtml(SHOP_PAGE);
    expect(extraction.text).not.toMatch(/[​\u0000]/);
    expect(JSON.stringify(extraction.structuredData)).not.toMatch(/​/);
    expect(extraction.pairs.every((pair) => !/[​\u0000]/.test(pair.value + pair.excerpt))).toBe(true);
  });
});

// ----------------------------------------------------------- 4 encoding

describe("a database that cannot store product knowledge", () => {
  it("is named, with the steps to create a UTF-8 one and nothing destructive", () => {
    const problem = encodingProblem("WIN1252", "preorder");
    expect(problem).toMatch(/"preorder" uses the WIN1252 encoding/);
    expect(problem).toContain("CREATE DATABASE preorder_utf8 ENCODING 'UTF8'");
    expect(problem).not.toMatch(/DROP DATABASE/i);
  });

  it("says nothing about a UTF-8 database, however it is spelt", () => {
    expect(encodingProblem("UTF8", "preorder")).toBeNull();
    expect(encodingProblem("utf-8", "preorder")).toBeNull();
  });
});

// ---------------------------------------------------- 5–6 database errors

/** The shape Drizzle and postgres-js give a failed insert. */
function drizzleFailure(code: string, message: string) {
  const cause = Object.assign(new Error(message), { code, table_name: "pkb_source_documents", severity: "ERROR" });
  const params = "x".repeat(50_000);
  return Object.assign(new Error(`Failed query: insert into "pkb_source_documents" ("id", "text_content") values ($1, $2)\nparams: ${params}`), {
    query: 'insert into "pkb_source_documents" ("id", "text_content") values ($1, $2)',
    params: [params],
    cause,
  });
}

describe("a database failure that will fail the same way again", () => {
  const encoding = drizzleFailure("22P05", 'character with byte sequence 0xe2 0x80 0x8b in encoding "UTF8" has no equivalent in encoding "WIN1252"');

  it("is recognised through the wrapper, including a source-storage one", () => {
    expect(isPermanentDatabaseError(encoding)).toBe(true);
    expect(isEncodingDatabaseError(encoding)).toBe(true);
    expect(isPermanentDatabaseError(new SourceStorageError("https://example.test/p", encoding))).toBe(true);
    expect(isPermanentDatabaseError(drizzleFailure("22021", "invalid byte sequence for encoding \"UTF8\": 0x00"))).toBe(true);
    expect(isPermanentDatabaseError(drizzleFailure("23514", "violates check constraint"))).toBe(true);
  });

  it("is never a deadlock, a serialisation failure, a lost connection or a race", () => {
    for (const code of ["40P01", "40001", "08006", "57P01", "53300", "23505", "23503"]) {
      expect(isPermanentDatabaseError(drizzleFailure(code, "transient"))).toBe(false);
    }
    expect(isTransientDatabaseError(drizzleFailure("40P01", "deadlock"))).toBe(true);
    expect(isPermanentDatabaseError(new Error("fetch failed"))).toBe(false);
  });

  it("is described by PostgreSQL's own words, without the stored values", () => {
    const described = describeDatabaseError(encoding);
    expect(described).toContain("[22P05]");
    expect(described).toContain('has no equivalent in encoding "WIN1252"');
    expect(described).toContain("table: pkb_source_documents");
    expect(described).not.toContain("xxxxxxxxxx");
    expect(described).not.toMatch(/\n|at .*\(.*:\d+:\d+\)/);
    expect(described.length).toBeLessThanOrEqual(500);
  });

  it("is recorded as a source-storage failure that preparation can explain", () => {
    expect(enrichmentFailure("source_storage_encoding: https://x.test — [22P05] …").kind).toBe("source_storage_encoding");
    expect(enrichmentFailure("source_storage: https://x.test — [23514] …").kind).toBe("source_storage");
    expect(enrichmentFailure("Failed query: insert into …")).toEqual({ kind: "other", detail: "Failed query: insert into …" });
    expect(enrichmentFailure(null).kind).toBe("other");
  });
});

// ------------------------------------------------------ 7–9 identifiers

describe("identifiers a shop page declares on its offers", () => {
  const identity = extractHtml(SHOP_PAGE).identity;

  it("reads the SKU from the Offer", () => {
    expect(identity.skus).toContain("GLO-OC-WL-BLK");
  });

  it("reads the GTIN from the Offer", () => {
    expect(identity.gtins).toContain("840408304115");
  });

  it("keeps each offer with the product that declared it", () => {
    expect(identity.offers).toEqual([
      { product: 0, productName: "Model O Classic Wireless Mouse", sku: "GLO-OC-WL-BLK", mpn: null, gtins: ["840408304115"] },
      { product: 1, productName: "GMP 2 Gaming Mouse Pad", sku: "GMP2-XL", mpn: null, gtins: ["0840408300001"] },
    ]);
  });

  it("treats a retailer's all-digit stock number as no model identifier", () => {
    expect(modelLikeSkus(["GLO-OC-WL-BLK", "6412345", "WH1000XM6"])).toEqual(["GLO-OC-WL-BLK", "WH1000XM6"]);
  });

  const recorded = (modelKeys: string[], gtins: string[] = []): ProductIdentity => ({
    pkbProductId: "p",
    name: "Glorious Model O",
    brands: [{ id: "b", name: "Glorious", key: "glorious" }],
    modelName: "Model O",
    generation: null,
    modelKeys,
    gtins: gtins.map((gtin14) => ({ gtin14, pkbVariantId: null })),
  });

  it("calls a page with a different model code a different product", () => {
    const verdict = identityVerdict(recorded(["GO-WHITE"]), extractHtml(SHOP_PAGE));
    expect(verdict.match).toBe("mismatch");
    const comparison = identityComparison("https://www.gloriousgaming.com/products/model-o", verdict.notes);
    expect(comparison.recorded).toContainEqual({ label: "Model / part number", values: ["GO-WHITE"] });
    expect(comparison.found).toContainEqual({ label: "SKU", values: ["GLO-OC-WL-BLK", "GMP2-XL"] });
    expect(comparison.found).toContainEqual({ label: "Brand", values: ["Glorious"] });
    expect(comparison.url).toBe("https://www.gloriousgaming.com/products/model-o");
  });

  it("agrees when the recorded model code is the page's SKU, or its GTIN matches", () => {
    expect(identityVerdict(recorded(["GLO-OC-WL-BLK"]), extractHtml(SHOP_PAGE)).match).toBe("match");
    expect(identityVerdict(recorded(["GO-WHITE"], ["00840408304115"]), extractHtml(SHOP_PAGE)).match).toBe("match");
  });

  it("still disagrees when the GTINs differ, whatever else agrees", () => {
    expect(identityVerdict(recorded(["GLO-OC-WL-BLK"], ["00012345678905"]), extractHtml(SHOP_PAGE)).match).toBe("mismatch");
  });
});

// ------------------------------------------------ 10–15 reading the page

describe("feature cards", () => {
  it("are read as a title and the paragraph that explains it, beside an icon", () => {
    const pairs = pairsOf(SHOP_PAGE);
    expect(pairs).toContainEqual(
      expect.objectContaining({
        label: "Gaming Grade 2.4GHz Wireless",
        value: "Low-latency wireless tuned for competitive play, with a range of up to ten metres.",
        locator: 'card "Gaming Grade 2.4GHz Wireless"',
      }),
    );
    expect(labelsOf(SHOP_PAGE)).toContain("Ultralight Weight");
  });

  it("are not read out of a review, even one shaped like a card", () => {
    expect(labelsOf(SHOP_PAGE)).not.toContain("Sam R.");
  });

  it("are not read when the card sells something or holds a button", () => {
    const html = `<div><div><img src="a.png"></div><div>Model O 2</div><p>The successor, lighter still and wireless.</p><a href="/p">Shop now</a></div>
      <div><div><img src="b.png"></div><div>Quick add</div><p>Add this to your basket in one step without leaving the page.</p><button>Add</button></div>`;
    expect(pairsOf(html)).toEqual([]);
  });
});

describe("the specification table", () => {
  it("keeps every technical row, in order", () => {
    const pairs = pairsOf(SHOP_PAGE).filter((pair) => pair.method === "html_table");
    expect(pairs.map((pair) => [pair.label, pair.value])).toEqual([
      ["Warranty", "2 years"],
      ["Weight", "69g"],
      ["Max Sensitivity (DPI)", "19,000 DPI"],
      ["Included", "• 1× USB Receiver • 1× USB-A to USB-C Cable"],
    ]);
  });

  it("is still read inside a modal, a drawer or a dialog — where full specifications often live", () => {
    const html = `<div class="specs-modal" role="dialog" aria-modal="true"><table><tr><td>Sensor</td><td>19k Optical</td></tr></table></div>
      <div class="spec-drawer"><div class="row"><div>Feet</div><div>PTFE</div></div></div>`;
    expect(pairsOf(html).map((pair) => pair.label)).toEqual(["Sensor", "Feet"]);
  });
});

describe("page furniture", () => {
  const labels = labelsOf(SHOP_PAGE);
  const values = pairsOf(SHOP_PAGE).map((pair) => pair.value);

  it("never turns a call to action into a value", () => {
    expect(values).not.toContain("Add to Cart");
    expect(values).not.toContain("Close");
    expect(labels).not.toContain("Model O Classic");
  });

  it("never reads a review's name and score, a newsletter or the footer", () => {
    expect(labels).not.toContain("Nathan k.");
    expect(values.some((value) => /5\/5|★/.test(value))).toBe(false);
    expect(labels).not.toContain("You're on the List!");
    expect(labels).not.toContain("Support");
  });

  it("never reads a banner selling another product", () => {
    expect(labels).not.toContain("GMP 2 Gaming Mouse Pad");
    expect(labels).not.toContain("PERFECT PAIRING");
  });

  it("never reads navigation, nor a sentence broken across two elements", () => {
    expect(labels).not.toContain("Mice");
    expect(labels.some((label) => label.startsWith("Model O Classic gives you"))).toBe(false);
  });

  it("keeps a heading and its paragraph that describe the product", () => {
    expect(pairsOf(SHOP_PAGE)).toContainEqual(
      expect.objectContaining({ label: "6 Remappable Buttons", value: "Map your go-to abilities and shortcuts exactly where they feel right." }),
    );
  });

  it("never stores a JSON store from an x-data container or a hidden config block as visible text", () => {
    const { text } = extractHtml(SHOP_PAGE);
    expect(text).not.toContain('{"title"');
    expect(text).not.toContain("themeColor");
    expect(text).not.toContain("Nathan k.");
    expect(text).toContain("Ultralight Weight");
    expect(text).toContain("19,000 DPI");
  });
});

describe("the same statement read twice", () => {
  it("is one pair", () => {
    // A heading followed by one block, which is also a two-element row.
    const html = `<div><h4>Battery Life</h4><p>71 hrs (no RGB)</p></div><dl><dt>Battery Life</dt><dd>71 hrs (no RGB).</dd></dl>`;
    const pairs = pairsOf(html).filter((pair) => pair.label === "Battery Life");
    expect(pairs).toHaveLength(1);
  });

  it("keeps two different values under one label", () => {
    const html = `<table><tr><td>Colour</td><td>Black</td></tr><tr><td>Colour</td><td>White</td></tr></table>`;
    expect(pairsOf(html).map((pair) => pair.value)).toEqual(["Black", "White"]);
  });
});

// ----------------------------------------- 16–19 identity labels, content

describe("the one list of labels that name a product", () => {
  it("covers every identifier the two old lists knew, and what each missed", () => {
    for (const label of ["Brand", "Manufacturer", "Model", "Model name", "Model number", "Model No.", "Part number", "MPN",
      "Manufacturer part number", "GTIN", "GTIN-12", "UPC", "EAN", "ISBN", "SKU", "ASIN"]) {
      expect(isIdentityLabel(label), label).toBe(true);
    }
    expect(identityLabelKind("GTIN-12")).toBe("gtin");
    expect(isIdentityLabel("Weight")).toBe(false);
    expect(isIdentityLabel("Max Sensitivity (DPI)")).toBe(false);
  });

  it("recognises a feature line that only restates an identifier", () => {
    expect(isIdentityLine("Part number: GO-WHITE")).toBe(true);
    expect(isIdentityLine("MPN — GO-WHITE")).toBe(true);
    expect(isIdentityLine("Weight: 69g")).toBe(false);
    expect(isIdentityLine("Works with the Model O 2 receiver")).toBe(false);
  });
});

const emptyResearch = { siteSearch: null, keywordMetrics: [], serp: [] };

function knowledgeWith(rows: { label: string; value: string }[]): GroundedKnowledge {
  return {
    ...EMPTY_GROUNDED,
    attributes: rows.map((row) => ({
      key: row.label.toLowerCase().replace(/W+/g, "_"),
      label: row.label,
      value: row.value,
      unit: null,
      pkbVariantId: null,
      state: "VERIFIED",
    })),
  };
}

function input(overrides: Partial<SeoPulseInput> = {}): SeoPulseInput {
  return {
    productId: "00000000-0000-4000-8000-000000000001",
    knowledge: EMPTY_GROUNDED,
    title: "Glorious Model O",
    slug: "glorious-model-o",
    brand: "Glorious",
    sku: null,
    identifierType: null,
    identifierValue: null,
    categoryId: "00000000-0000-4000-8000-000000000002",
    categoryPath: ["Electronics"],
    status: "draft",
    descriptionText: "",
    bulletFeatures: [],
    specifications: [],
    measurements: [],
    details: { modelNumber: "GO-WHITE", manufacturerPartNumber: "GO-WHITE" },
    boxContents: [],
    warranty: null,
    countryOfOrigin: null,
    tags: [],
    searchKeywords: [],
    searchable: true,
    seoFocusKeyword: null,
    seoMetaTitle: null,
    seoMetaDescription: null,
    seoNoIndex: false,
    images: [],
    hasVideo: false,
    variants: [],
    reviews: { count: 0, average: null },
    ...overrides,
  };
}

describe("a product known only by its identifiers", () => {
  const identifiersOnly = input({
    knowledge: knowledgeWith([
      { label: "Brand", value: "Glorious" },
      { label: "Model", value: "Model O" },
      { label: "MPN", value: "GO-WHITE" },
      { label: "Part number", value: "GO-WHITE" },
    ]),
  });

  it("does not get Part number or MPN as key features", () => {
    const generated = generateByRules(identifiersOnly, emptyResearch);
    expect(generated.keyFeatures).toEqual([]);
  });

  it("is identified but not described: identifier rows and bullets add nothing", () => {
    const plain = knowledgeSufficiency(identifiersOnly);
    const withBullets = knowledgeSufficiency({ ...identifiersOnly, bulletFeatures: ["Part number: GO-WHITE", "MPN: GO-WHITE"] });
    expect(plain.sufficient).toBe(false);
    expect(withBullets.facts).toBe(plain.facts);
    expect(withBullets.missing).toContain("Key features");
  });

  it("gets no description at all, and never the category filler", () => {
    const html = generateByRules(identifiersOnly, emptyResearch).description.suggestedHtml;
    expect(html).toBeNull();
  });
});

describe("a researched product's description", () => {
  const researched = input({
    knowledge: knowledgeWith([
      { label: "Weight", value: "69g" },
      { label: "Max Sensitivity (DPI)", value: "19,000 DPI" },
      { label: "Sensor", value: "19k Optical" },
      { label: "Part number", value: "GLO-OC-WL-BLK" },
    ]),
    variants: [{ fulfillmentMode: "preorder", arrivesFrom: "12 Oct", arrivesTo: null }] as unknown as SeoPulseInput["variants"],
    warranty: { hasWarranty: true, durationMonths: 24 } as SeoPulseInput["warranty"],
  });
  const html = generateByRules(researched, emptyResearch).description.suggestedHtml ?? "";

  it("begins with something about the product", () => {
    expect(html).toMatch(/^<p>[^<]*— (Weight: 69g|Max Sensitivity|Sensor)/);
  });

  it("never says the product is part of a category range", () => {
    expect(html).not.toMatch(/part of our/i);
    expect(html).not.toContain("Electronics range");
  });

  it("carries no buying, preorder, arrival, landed-price or delivery block", () => {
    expect(html).not.toContain("Buying it here");
    expect(html).not.toMatch(/preorder|expected to arrive|customs duty|delivered across Bangladesh|month warranty/i);
  });

  it("lists no identifier as a key feature", () => {
    expect(html).not.toContain("Part number");
  });
});

// --------------------------------------------------- 24–25 research state

describe("what the editor and the staff preview say about research", () => {
  it("says research is incomplete while knowledge is insufficient, whatever the run says", () => {
    for (const stage of [null, "NEEDS_REVIEW", "READY"] as const) {
      const status = describeResearchStatus({ stage, sufficient: false, missing: ["Specifications"] });
      expect(status?.state).toBe("incomplete");
      expect(status?.label).toBe("Research incomplete");
      expect(status?.detail).toContain("SeoPulse still needs product information — Specifications");
    }
  });

  it("says research is incomplete while preparation is still waiting", () => {
    const status = describeResearchStatus({ stage: "NEEDS_REVIEW", sufficient: true, missing: [] });
    expect(status).toMatchObject({ state: "incomplete", label: "Research incomplete" });
  });

  it("says research is ready once preparation finished and the knowledge holds", () => {
    expect(describeResearchStatus({ stage: "READY", sufficient: true, missing: [] })).toMatchObject({
      state: "ready",
      label: "Product research ready",
    });
  });

  it("says nothing about a product described by hand that was never prepared", () => {
    expect(describeResearchStatus({ stage: null, sufficient: true, missing: [] })).toBeNull();
  });
});

describe("a list written as one value", () => {
  it("splits the manufacturer's bulleted box contents into items", () => {
    expect(listItems("• 1× USB Receiver • 1× Ascended USB-A to USB-C Cable • 1× USB-A to USB-C Adapter")).toEqual([
      "1× USB Receiver",
      "1× Ascended USB-A to USB-C Cable",
      "1× USB-A to USB-C Adapter",
    ]);
    expect(listItems("Mouse\nReceiver\r\nCable")).toEqual(["Mouse", "Receiver", "Cable"]);
  });

  it("leaves a value that is not a list as itself", () => {
    expect(listItems("USB-A to USB-C cable, braided")).toEqual(["USB-A to USB-C cable, braided"]);
    expect(listItems("2.4 GHz · Wired")).toEqual(["2.4 GHz · Wired"]);
    expect(listItems("• Carry case")).toEqual(["Carry case"]);
  });
});

// ------------------------------------------------ Case B's regenerated wording

describe("the Glorious Model O Classic Wireless, regenerated (D-120)", () => {
  const caseB = input({
    title: "Glorious Model O Classic Wireless Mouse",
    details: { size: "Standard", manufacturerPartNumber: "GLO-OC-WL-BLK" },
    knowledge: knowledgeWith([
      { label: "Size", value: "Standard" },
      { label: "Weight", value: "69g" },
      { label: "Max Sensitivity (DPI)", value: "19,000 DPI" },
      { label: "Warranty", value: "2 years" },
      { label: "Connectivity", value: "2.4 GHz Wireless, Wired" },
      { label: "Part number", value: "GLO-OC-WL-BLK" },
    ]),
    boxContents: ["1× USB Receiver", "1× Ascended USB-A to USB-C Cable", "1× USB-A to USB-C Adapter"],
  });
  const generated = generateByRules(caseB, emptyResearch);
  const html = generated.description.suggestedHtml ?? "";

  it("never says the product comes in a named size", () => {
    expect(html).not.toContain("It comes with in");
    expect(html).not.toContain("It comes in Standard");
  });

  it("opens on what the product does, not its size or its warranty", () => {
    expect(html).toMatch(/^<p>Glorious Model O Classic Wireless Mouse — Max Sensitivity \(DPI\): 19,000 DPI\./);
    expect(generated.keyFeatures[0]).toBe("Max Sensitivity (DPI): 19,000 DPI");
    expect(generated.keyFeatures.some((line) => /warranty|part number|mpn/i.test(line))).toBe(false);
  });

  it("lists each thing in the box as its own item", () => {
    expect(html).toContain(
      "<h2>In the box</h2><ul><li>1× USB Receiver</li><li>1× Ascended USB-A to USB-C Cable</li><li>1× USB-A to USB-C Adapter</li></ul>",
    );
  });

  it("still says a measured size", () => {
    const measured = generateByRules(input({ ...caseB, details: { size: "42 mm" } }), emptyResearch);
    expect(measured.description.suggestedHtml).toContain("It comes in 42 mm.");
  });
});
