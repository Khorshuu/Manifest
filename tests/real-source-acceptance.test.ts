/**
 * What a real manufacturer's page has to be able to do (D-074, D-113, D-115).
 *
 * Every defect this file covers was found by putting three real products —
 * an iPhone 11 Pro Max, a Sony WH-1000XM6 and an Anker power bank — through
 * Add Product → Research & Prepare with SeoPulse against the manufacturers'
 * own pages. None of it reaches the network: the shapes those pages are
 * written in are reproduced here as fixtures, so the contract is pinned
 * without a test that fails when Apple redesigns a page.
 */
import { describe, expect, it } from "vitest";
import { extractHtml } from "@/lib/pkb/extract";
import { identityVerdict } from "@/lib/pkb/enrichment";
import type { ProductIdentity } from "@/lib/pkb/resolution";
import { knowledgeSufficiency, measurementRows, specificationRows } from "@/lib/seo-pulse/facts";
import { generateByRules } from "@/lib/seo-pulse/rules";
import { EMPTY_GROUNDED } from "@/lib/pkb/publish";
import type { SeoPulseInput } from "@/lib/seo-pulse/types";

// ---------------------------------------------------------------- fixtures

/** Apple's technical specifications: a heading, then a list of bullets. */
const HEADING_AND_LIST = `<!doctype html><html><head><title>iPhone 11 Pro Max - Technical Specifications</title></head>
<body>
  <nav><h2>Support</h2><ul><li><a href="/a">iPhone</a></li><li><a href="/b">iPad</a></li></ul></nav>
  <h1>iPhone 11 Pro Max - Technical Specifications</h1>
  <div class="group"><h3>Size and Weight</h3><ul>
    <li><p>Width: 3.06 inches (77.8 mm)</p></li>
    <li><p>Height: 6.22 inches (158.0 mm)</p></li>
    <li><p>Weight: 7.97 ounces (226 grams)</p></li>
  </ul></div>
  <div class="group"><h3>Chip</h3><ul>
    <li><p>A13 Bionic chip</p></li>
    <li><p>Third-generation Neural Engine</p></li>
  </ul></div>
</body></html>`;

/** Sony's Help Guide: a heading holding the label, then paragraphs. */
const HEADING_AND_PARAGRAPHS = `<!doctype html><html><head><title>WH-1000XM6 | Help Guide | Specifications</title></head>
<body>
  <h4><b><span>Mass</span>: </b></h4><p>Approx. 254 g (9 oz)</p>
  <h4><b><span>Supported Codec</span><sup>4)</sup>: </b></h4><p>SBC</p><p>AAC</p><p>LDAC</p>
</body></html>`;

/** Anker's product page: a specification row built from two divs. */
const LAYOUT_ROWS = `<!doctype html><html><head><title>Anker Prime Power Bank (27K, 250W)</title></head>
<body>
  <div class="specs">
    <div class="row"><div>Total Capacity</div><div>27,650mAh (3,950mAh × 7)</div></div>
    <div class="row"><div>Weight</div><div>665g</div></div>
    <div class="row"><div>Footnote</div><div>2)</div></div>
  </div>
</body></html>`;

function pairsOf(html: string): Record<string, string> {
  return Object.fromEntries(extractHtml(html).pairs.map((pair) => [pair.label, pair.value]));
}

// ------------------------------------------------------------- extraction

describe("reading a manufacturer's specification page", () => {
  it("reads a heading followed by a list, and splits its labelled lines", () => {
    const pairs = pairsOf(HEADING_AND_LIST);
    expect(pairs["Width"]).toBe("3.06 inches (77.8 mm)");
    expect(pairs["Weight"]).toBe("7.97 ounces (226 grams)");
    expect(pairs["Chip"]).toBe("A13 Bionic chip; Third-generation Neural Engine");
  });

  it("does not report the same fact twice, once per section that contains it", () => {
    const labels = extractHtml(HEADING_AND_LIST).pairs.map((pair) => pair.label);
    expect(labels.filter((label) => label === "Width")).toHaveLength(1);
  });

  it("leaves a navigation block alone: it is links, not information", () => {
    expect(pairsOf(HEADING_AND_LIST)["Support"]).toBeUndefined();
  });

  it("reads a heading followed by paragraphs, and drops the footnote mark", () => {
    const pairs = pairsOf(HEADING_AND_PARAGRAPHS);
    expect(pairs["Mass"]).toBe("Approx. 254 g (9 oz)");
    expect(pairs["Supported Codec"]).toBe("SBC; AAC; LDAC");
  });

  it("reads a two-element layout row, which is what a specification table is now", () => {
    const pairs = pairsOf(LAYOUT_ROWS);
    expect(pairs["Total Capacity"]).toBe("27,650mAh (3,950mAh × 7)");
    expect(pairs["Weight"]).toBe("665g");
  });

  it("never takes a footnote reference as a value", () => {
    expect(pairsOf(LAYOUT_ROWS)["Footnote"]).toBeUndefined();
  });

  it("records what the document calls itself, so identity has something to compare", () => {
    expect(extractHtml(HEADING_AND_PARAGRAPHS).identity.names).toContain(
      "WH-1000XM6 | Help Guide | Specifications",
    );
  });
});

// --------------------------------------------------------------- identity

const sonyIdentity: ProductIdentity = {
  pkbProductId: "00000000-0000-4000-8000-000000000001",
  name: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
  brands: [{ id: "00000000-0000-4000-8000-0000000000b1", key: "sony", name: "Sony" }],
  modelName: "WH-1000XM6",
  generation: null,
  modelKeys: ["WH1000XM6"],
  gtins: [],
};

describe("deciding whether a page is about this product", () => {
  it("is unknown when the page names neither the brand nor an identifier", () => {
    const extraction = extractHtml("<html><head><title>Specifications</title></head><body><p>Mass: 254 g</p></body></html>");
    expect(identityVerdict(sonyIdentity, extraction).match).toBe("unknown");
  });

  it("matches when an approved registry entry vouches for the brand and the page names the model", () => {
    const extraction = extractHtml(HEADING_AND_PARAGRAPHS);
    expect(identityVerdict(sonyIdentity, extraction, { brandVouched: true }).match).toBe("match");
  });

  it("does not let the registry stand in for a brand the page contradicts", () => {
    const extraction = extractHtml(
      `<html><head><title>WH-1000XM6 specifications</title></head><body><table><tr><td>Brand</td><td>Bose</td></tr></table></body></html>`,
    );
    expect(identityVerdict(sonyIdentity, extraction, { brandVouched: true }).match).toBe("mismatch");
  });

  it("still requires the model in the name, vouched or not", () => {
    const extraction = extractHtml("<html><head><title>WH-1000XM4 specifications</title></head><body></body></html>");
    expect(identityVerdict(sonyIdentity, extraction, { brandVouched: true }).match).toBe("unknown");
  });
});

// ------------------------------------------------------------ sufficiency

function sampleInput(overrides: Partial<SeoPulseInput> = {}): SeoPulseInput {
  return {
    productId: "00000000-0000-4000-8000-000000000001",
    knowledge: EMPTY_GROUNDED,
    title: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
    slug: "sony-wh-1000xm6",
    brand: "Sony",
    sku: "ACPT-WH1000XM6",
    identifierType: null,
    identifierValue: null,
    categoryId: "00000000-0000-4000-8000-000000000002",
    categoryPath: ["Audio", "Over-ear Headphones"],
    status: "draft",
    descriptionText: "",
    bulletFeatures: [],
    specifications: [],
    measurements: [],
    details: { modelName: "WH-1000XM6", modelNumber: "WH-1000XM6" },
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

const knowledgeWith = (attributes: { label: string; value: string; unit?: string | null }[]) => ({
  ...EMPTY_GROUNDED,
  attributes: attributes.map((attribute) => ({
    key: attribute.label.toLowerCase().replace(/\W+/g, "_"),
    label: attribute.label,
    value: attribute.value,
    unit: attribute.unit ?? null,
    pkbVariantId: null,
    state: "VERIFIED" as const,
  })),
});

describe("whether there is enough established fact to write from", () => {
  it("does not count the product's own name as knowledge about it", () => {
    const verdict = knowledgeSufficiency(sampleInput());
    expect(verdict.sufficient).toBe(false);
    expect(verdict.facts).toBe(2);
  });

  it("counts what the knowledge base established from the manufacturer", () => {
    const verdict = knowledgeSufficiency(
      sampleInput({
        knowledge: knowledgeWith([
          { label: "Mass", value: "Approx. 254 g (9 oz)" },
          { label: "Communication system", value: "Bluetooth Specification version 5.3" },
          { label: "Supported Codec", value: "SBC; AAC; LDAC; LC3" },
        ]),
      }),
    );
    expect(verdict.sufficient).toBe(true);
  });

  it("prints a unit only where the value does not already carry one", () => {
    const input = sampleInput({
      knowledge: knowledgeWith([
        { label: "Item weight", value: "665g", unit: "g" },
        { label: "Charging current", value: "3", unit: "A" },
      ]),
    });
    const rows = [...specificationRows(input), ...measurementRows(input)];
    expect(rows.find((row) => row.label === "Item weight")?.value).toBe("665g");
    expect(rows.find((row) => row.label === "Charging current")?.value).toBe("3 A");
  });
});

// ------------------------------------------------------------- the wording

const emptyResearch = { siteSearch: null, keywordMetrics: [], serp: [] };

describe("what the rules generator writes once a product is researched", () => {
  it("writes key features from established fact instead of leaving them empty", () => {
    const generated = generateByRules(
      sampleInput({
        knowledge: knowledgeWith([
          { label: "Mass", value: "Approx. 254 g (9 oz)" },
          { label: "Communication system", value: "Bluetooth Specification version 5.3" },
        ]),
      }),
      emptyResearch,
    );
    expect(generated.keyFeatures).toContain("Communication system: Bluetooth Specification version 5.3");
    expect(generated.description.suggestedHtml).toContain("Bluetooth Specification version 5.3");
  });

  it("does not open on the shop, and keeps what staff wrote when they wrote it", () => {
    const generated = generateByRules(
      sampleInput({ bulletFeatures: ["Industry-leading noise cancelling"] }),
      emptyResearch,
    );
    expect(generated.description.suggestedHtml).not.toMatch(/^<p>[^<]*sourced from the United States/);
    expect(generated.keyFeatures).toEqual([]);
    expect(generated.description.suggestedHtml).toContain("Industry-leading noise cancelling");
  });

  it("never lists the product's own name back as a feature", () => {
    const generated = generateByRules(
      sampleInput({ knowledge: knowledgeWith([{ label: "Brand", value: "Sony" }]) }),
      emptyResearch,
    );
    expect(generated.keyFeatures).toEqual([]);
  });
});
