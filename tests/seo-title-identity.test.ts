/**
 * D-130: product-type resolution, identity-aware SEO title fitting and
 * deterministic grammar. Every fixture is an invented product; no rule under
 * test names a brand, a category or a kind of product.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMPTY_GROUNDED, type GroundedKnowledge } from "@/lib/pkb/publish";
import { contentPlan, factMetaSentence, identitySentence, openingSentence } from "@/lib/seo-pulse/content-plan";
import { structuredProductTypes } from "@/lib/seo-pulse/product-type";
import { applyQualityGate } from "@/lib/seo-pulse/quality";
import { generateByRules } from "@/lib/seo-pulse/rules";
import { sanitizeGenerated } from "@/lib/seo-pulse/sanitize";
import { sentences } from "@/lib/seo-pulse/text";
import {
  fitSeoTitle,
  resolveProductType,
  SEO_TITLE_HARD_MAX,
  SEO_TITLE_MAX,
  SEO_TITLE_TARGET,
  SITE_TITLE_SUFFIX,
  titleIdentity,
  type TitleIdentity,
} from "@/lib/seo-pulse/title-fit";
import type { GeneratedRecommendations, SeoPulseInput } from "@/lib/seo-pulse/types";

// ------------------------------------------------------------ fixtures

type Row = { label: string; value: string };

function knowledge(
  rows: (Row & { key?: string; variant?: boolean })[],
  options: { family?: string; brand?: string; modelName?: string } = {},
): GroundedKnowledge {
  return {
    ...EMPTY_GROUNDED,
    brand: options.brand ?? null,
    modelName: options.modelName ?? null,
    attributes: rows.map((row, index) => ({
      key: row.key ?? `k${index}`,
      label: row.label,
      value: row.value,
      unit: null,
      pkbVariantId: row.variant ? "00000000-0000-4000-8000-0000000000aa" : null,
      state: "VERIFIED",
    })),
    family: options.family ? { id: "f1", name: options.family, attributes: [] } : null,
  } as GroundedKnowledge;
}

function input(overrides: Partial<SeoPulseInput> = {}): SeoPulseInput {
  return {
    productId: "00000000-0000-4000-8000-000000000001",
    knowledge: EMPTY_GROUNDED,
    title: "Tessera Vx-70 Graphics Card 12GB",
    slug: "tessera-vx-70",
    brand: "Tessera",
    sku: null,
    identifierType: null,
    identifierValue: null,
    categoryId: "00000000-0000-4000-8000-000000000002",
    categoryPath: [],
    status: "draft",
    descriptionText: "",
    bulletFeatures: [],
    specifications: [],
    measurements: [],
    details: {},
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
  } as SeoPulseInput;
}

const identity = (overrides: Partial<TitleIdentity> = {}): TitleIdentity => ({
  brand: null,
  model: null,
  productType: [],
  variants: [],
  factText: "",
  ...overrides,
});

/** Every word of the fitted title is a whole word of the original, in order. */
function wholeWordsInOrder(fitted: string, original: string): boolean {
  const source = original.split(/\s+/);
  let at = 0;
  for (const word of fitted.replace(/,/g, "").split(/\s+/)) {
    const found = source.findIndex((candidate, index) => index >= at && candidate.replace(/,/g, "") === word);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

const OIL = "Harvest Hill Premium Extra Virgin Olive Oil Cold Pressed Unfiltered Glass Bottle 1 L";
const oil = (overrides: Partial<SeoPulseInput> = {}) => input({ title: OIL, brand: "Harvest Hill", ...overrides });

// ------------------------------------------------ 1. product type (1–7)

describe("the product type comes from the strongest source there is (D-130)", () => {
  it("takes a specific family first", () => {
    const card = input({ knowledge: knowledge([], { family: "Graphics Cards" }), categoryPath: ["Pantry", "Olive Oils"] });
    expect(resolveProductType(card)).toEqual({ type: "Graphics Card", source: "family" });
    // A family names the type even when the title does not say it.
    expect(resolveProductType({ ...card, title: "Tessera Vx-70 OC 12GB" })).toEqual({ type: "Graphics Cards", source: "family" });
  });

  it("takes a specific category when there is no family", () => {
    const named = oil({ categoryPath: ["Pantry", "Olive Oils"], categoryShape: { hasChildren: false, hasFamily: true } });
    expect(resolveProductType(named)).toEqual({ type: "Olive Oil", source: "category" });
    // A leaf the title names is specific even without a family.
    expect(resolveProductType(oil({ categoryPath: ["Pantry", "Olive Oils"] })).source).toBe("category");
  });

  it("does not take a broad category for the product type", () => {
    // A category with others under it is a grouping, even when the name uses its word.
    const grouping = input({ title: "Tessera Home Speaker Vx-70", categoryPath: ["Home"], categoryShape: { hasChildren: true, hasFamily: false } });
    expect(structuredProductTypes(grouping)).toEqual([]);
    expect(resolveProductType(grouping).source).not.toBe("category");
    // A leaf the name does not use, with no family behind it, is not assumed to be specific.
    expect(structuredProductTypes(oil({ categoryPath: ["Pantry"], categoryShape: { hasChildren: false, hasFamily: false } }))).toEqual([]);
    // Levels above the product's own category are groupings.
    expect(structuredProductTypes(oil({ categoryPath: ["Olive Oils", "Pantry"] })).map((type) => type.name)).toEqual([]);
  });

  it("uses a recorded product type, and the title only when nothing stronger exists", () => {
    const recorded = oil({ knowledge: knowledge([{ key: "product_type", label: "Product type", value: "Olive oil" }]) });
    expect(resolveProductType(recorded)).toEqual({ type: "Olive Oil", source: "attribute" });

    const vocabulary = "Pressed within hours of harvest. This olive oil suits dressings. Keep the olive oil from light.";
    // The listing's own words confirm the type only when no structured name does.
    expect(resolveProductType(oil({ descriptionText: vocabulary }))).toEqual({ type: "Olive Oil", source: "title" });
    const withFamily = oil({ descriptionText: vocabulary, knowledge: knowledge([], { family: "Pantry oils" }) });
    expect(resolveProductType(withFamily).source).toBe("family");
    // SeoPulse's own earlier wording is not the listing's (D-120).
    expect(resolveProductType(oil({ descriptionText: vocabulary, pulseWritten: { description: true, bulletFeatures: false } })).type).toBeNull();
  });

  it("does not take a packaging tail for the product type", () => {
    const resolved = resolveProductType(oil());
    expect(resolved.type ?? "").not.toMatch(/Bottle|Glass/);
    // A container the facts state is a description, not the type.
    const stated = input({ title: "Harvest Hill Organic Honey Squeeze Bottle", brand: "Harvest Hill", knowledge: knowledge([{ label: "Container", value: "Squeeze bottle" }]) });
    expect(resolveProductType(stated).type).toBeNull();
  });

  it("answers unknown rather than guessing", () => {
    expect(resolveProductType(oil())).toEqual({ type: null, source: null });
    // A clean name with nothing against it still gives its closing words, marked as from the title.
    expect(resolveProductType(input({ title: "Tessera Vx-70 Bluetooth Speaker" }))).toEqual({ type: "Bluetooth Speaker", source: "title" });
  });

  it("names no brand, category or kind of product in the code", () => {
    const source = readFileSync("lib/seo-pulse/product-type.ts", "utf8") + readFileSync("lib/seo-pulse/title-fit.ts", "utf8");
    for (const name of ["Tessera", "Harvest", "Maison", "Kestrel", "Brightwave", "Oakhollow"]) expect(source).not.toContain(name);
    // Kinds of product appear only in comments, as examples, never as a value the code compares with.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/olive|bottle|graphics|lipstick|phone|electronics|pantry|parfum/i);
  });
});

// ------------------------------------------------ 2. title fitting (8–23)

const CARD = identity({ brand: "Tessera", model: "Vx-70 Ti Nova-X", productType: ["Graphics Cards"], factText: "16gb gddr7 triple fan" });
const LONG_CARD = "Tessera Vx-70 Ti Nova-X Triple Fan Silent Cooling Edition 16GB GDDR7 Graphics Card";

describe("SEO titles keep the product's identity (D-130)", () => {
  it("leaves a name that fits unchanged", () => {
    expect(fitSeoTitle("Tessera Vx-70 Ti Graphics Card", CARD)).toBe("Tessera Vx-70 Ti Graphics Card");
  });

  it("removes low-value words first, and a packaging tail before identity", () => {
    const fitted = fitSeoTitle(OIL, titleIdentity(oil({ categoryPath: ["Pantry", "Olive Oils"], categoryShape: { hasChildren: false, hasFamily: true } })));
    expect(fitted).toBe("Harvest Hill Extra Virgin Olive Oil 1 L");
    expect(fitted).not.toMatch(/Premium|Glass|Bottle|Cold|Pressed/);
  });

  it("keeps the model code, the word that completes it, and the confirmed type", () => {
    const fitted = fitSeoTitle(LONG_CARD, CARD);
    expect(fitted).toBe("Tessera Vx-70 Ti Nova-X 16GB GDDR7 Graphics Card");
    expect(fitted.length).toBeLessThanOrEqual(SEO_TITLE_TARGET);
    // The model's own name survives even when it is a plain word.
    const tablet = fitSeoTitle(
      "Tessera Slate 11 Tablet 11-inch Display Octa-Core Processor 256GB Wi-Fi Space Grey",
      identity({ brand: "Tessera", model: "Slate 11", productType: ["Tablets"], variants: ["Wi-Fi"] }),
    );
    expect(tablet).toMatch(/^Tessera Slate 11 Tablet /);
  });

  it("keeps a variant's capacity, shade, size and generation", () => {
    const phone = fitSeoTitle(
      "Tessera Nova 8 Pro Smartphone Dual SIM Unlocked Android Phone 256GB Midnight Black",
      titleIdentity(input({ title: "", details: { modelName: "Nova 8 Pro", capacity: "256GB", color: "Midnight Black" } })),
    );
    expect(phone).toContain("256GB");
    expect(phone).toContain("Midnight Black");

    const lipstick = fitSeoTitle("Maison Lune Velvet Matte Long Lasting Liquid Lipstick Transfer Proof Shade 150 Rosewood", identity({ brand: "Maison Lune", productType: ["Lipsticks"] }));
    expect(lipstick).toBe("Maison Lune Velvet Matte Lipstick Shade 150");

    const perfume = fitSeoTitle("Maison Lune Nuit Intense Extrait Eau de Parfum Spray for Women 100 ml", identity({ brand: "Maison Lune", productType: ["Eau de Parfum"], variants: ["100 ml"] }));
    expect(perfume).toContain("100 ml");
    expect(perfume).toContain("Eau de Parfum");

    const buds = fitSeoTitle("Brightwave Pulse Wireless Earbuds Active Noise Cancelling Bluetooth 5.3 Charging Case Gen 3", identity({ brand: "Brightwave", model: "Pulse", productType: ["Earbuds"] }));
    expect(buds).toMatch(/Gen 3$/);
    // A variant-level fact in the knowledge base counts as the variant's value.
    const variantFact = titleIdentity(input({ knowledge: knowledge([{ label: "Storage", value: "512GB", variant: true }]) }));
    expect(fitSeoTitle("Tessera Nova 8 Pro Smartphone Dual SIM Unlocked Android Phone 512GB Midnight Black Edition", variantFact)).toContain("512GB");
  });

  it("never cuts inside a word or a model code, and never ends on half a type", () => {
    const names = [
      LONG_CARD,
      OIL,
      "Kestrel Trailhead Vacuum Insulated Stainless Steel Water Bottle Leak Proof Lid 750 ml",
      "Maison Lune Nuit Intense Extrait Eau de Parfum Spray for Women 100 ml",
    ];
    for (const name of names) {
      const fitted = fitSeoTitle(name, identity({ brand: name.split(" ")[0], productType: ["Graphics Cards", "Eau de Parfum"] }));
      expect(fitted.length).toBeLessThanOrEqual(SEO_TITLE_MAX);
      expect(wholeWordsInOrder(fitted, name)).toBe(true);
      expect(fitted).not.toMatch(/\b(?:and|with|for|of|to|x|de)$/i);
    }
    expect(fitSeoTitle(LONG_CARD, CARD)).toMatch(/Graphics Card$/);
    // Without any structured type, a clean closing type is still kept whole.
    expect(fitSeoTitle(LONG_CARD, { ...CARD, productType: [] })).toMatch(/Graphics Card$/);
  });

  it("leaves the site's name to the page, exactly once", () => {
    const fitted = fitSeoTitle(`${LONG_CARD} · Manifest · Manifest`, CARD);
    expect(fitted).not.toMatch(/manifest/i);
    expect(`${fitted}${SITE_TITLE_SUFFIX}`.match(/Manifest/g)).toHaveLength(1);
    expect(fitSeoTitle("Tessera Vx-70 Ti Graphics Card | Manifest", CARD)).toBe("Tessera Vx-70 Ti Graphics Card");
  });

  it("never shortens two variants to the same title", () => {
    const phone = (capacity: string) =>
      fitSeoTitle(
        `Tessera Nova 8 Pro Smartphone Dual SIM Unlocked Android Phone ${capacity} Black`,
        titleIdentity(input({ title: "", details: { modelName: "Nova 8 Pro", capacity, color: "Black" } })),
      );
    expect(phone("128GB")).not.toBe(phone("256GB"));

    const pairs: [string, string, Partial<TitleIdentity>, Partial<TitleIdentity>][] = [
      ["Maison Lune Velvet Matte Long Lasting Liquid Lipstick Transfer Proof Shade 120", "Maison Lune Velvet Matte Long Lasting Liquid Lipstick Transfer Proof Shade 150", {}, {}],
      ["Maison Lune Nuit Intense Extrait Eau de Parfum Spray for Women 50 ml", "Maison Lune Nuit Intense Extrait Eau de Parfum Spray for Women 100 ml", { variants: ["50 ml"] }, { variants: ["100 ml"] }],
      ["Brightwave Pulse Wireless Earbuds Active Noise Cancelling Bluetooth 5.3 Charging Case Gen 2", "Brightwave Pulse Wireless Earbuds Active Noise Cancelling Bluetooth 5.3 Charging Case Gen 3", { model: "Pulse" }, { model: "Pulse" }],
      ["Tessera Slate 11 Tablet 11-inch Display Octa-Core 256GB Wi-Fi Space Grey", "Tessera Slate 11 Tablet 11-inch Display Octa-Core 256GB Wi-Fi + Cellular Space Grey", { model: "Slate 11", variants: ["Wi-Fi"] }, { model: "Slate 11", variants: ["Wi-Fi + Cellular"] }],
      ["Tessera Vx-70 Nova-X Triple Fan Silent Cooling Edition 16GB GDDR7 Graphics Card", "Tessera Vx-70 Ti Nova-X Triple Fan Silent Cooling Edition 16GB GDDR7 Graphics Card", { model: "Vx-70 Nova-X" }, { model: "Vx-70 Ti Nova-X" }],
    ];
    for (const [a, b, first, second] of pairs) {
      const base = { brand: a.split(" ")[0] === "Maison" ? "Maison Lune" : a.split(" ")[0], factText: "16gb gddr7 triple fan" };
      const fittedA = fitSeoTitle(a, identity({ ...base, ...first }));
      const fittedB = fitSeoTitle(b, identity({ ...base, ...second }));
      expect(fittedA).not.toBe(fittedB);
    }
    expect(fitSeoTitle(pairs[3][1], identity({ brand: "Tessera", ...pairs[3][3] }))).toContain("Wi-Fi + Cellular");
  });

  it("lets a very long critical identity pass the preferred length rather than lose part of it", () => {
    const huge = "Tessera Vx-70 Ti Nova-X OC-EDITION Graphics Card 16GB GDDR7 PCIe-5.0 Triple Fan Midnight Black";
    const fitted = fitSeoTitle(huge, identity({ brand: "Tessera", model: "Vx-70 Ti Nova-X OC-EDITION", productType: ["Graphics Cards"], variants: ["Midnight Black"] }));
    expect(fitted).toBe("Tessera Vx-70 Ti Nova-X OC-EDITION Graphics Card Midnight Black");
    expect(fitted.length).toBeGreaterThan(SEO_TITLE_MAX);
    expect(fitted.length).toBeLessThanOrEqual(SEO_TITLE_HARD_MAX);
    // Past what a stored title holds, the type and then whole codes go before a variant's value.
    const longer = "Tessera Vx-70 Ti Nova-X OC-EDITION RGB-ARGB XLR8-GAMING Graphics Card 16GB GDDR7 Midnight Black";
    const cut = fitSeoTitle(longer, identity({ brand: "Tessera", model: "Vx-70 Ti Nova-X OC-EDITION RGB-ARGB XLR8-GAMING", productType: ["Graphics Cards"], variants: ["Midnight Black"] }));
    expect(cut.length).toBeLessThanOrEqual(SEO_TITLE_HARD_MAX);
    expect(cut).toMatch(/^Tessera Vx-70 /);
    expect(cut).toMatch(/Midnight Black$/);
  });

  it("is what a sanitised model title uses, with no second call", () => {
    const product = input({ title: OIL, brand: "Harvest Hill", categoryPath: ["Pantry", "Olive Oils"], categoryShape: { hasChildren: false, hasFamily: true } });
    const research = { siteSearch: null, keywordMetrics: [], serp: [] };
    const rules = sanitizeGenerated(generateByRules(product, research), product);
    const sanitized = sanitizeGenerated({ ...rules, seoTitle: { recommended: OIL, alternatives: [], reason: "x" } }, product);
    expect(sanitized.seoTitle.recommended).toBe("Harvest Hill Extra Virgin Olive Oil 1 L");
  });
});

// ------------------------------------------------ 3. grammar (24–35)

const plan = (name: string, facts: Row[]) => ({ exactName: name, facts });
const FACTS = [
  { label: "Memory", value: "12GB GDDR7" },
  { label: "Boost Clock", value: "2685 MHz" },
];

describe("deterministic sentences never guess a product's grammatical number (D-130)", () => {
  it("reads correctly whatever the name ends in", () => {
    for (const name of ["Tessera Vx-70 Series", "Tessera Prime 50mm f/1.8 Lens", "Brightwave Pulse 2 Headphones", "Kestrel Ridge Slim Fit Jeans", "Maison Lune Nuit Collector's Edition"]) {
      const opening = openingSentence(plan(name, FACTS));
      expect(opening).toBe(`Key specifications of the ${name} include 12GB GDDR7 memory and 2685 MHz boost clock.`);
      expect(opening).not.toMatch(/\b(?:has|have)\b/);
      const meta = factMetaSentence(plan(name, FACTS));
      expect(meta).toMatch(new RegExp(`^Key specifications of the ${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} include `));
      expect(meta).not.toMatch(/\b(?:feature|features|has|have)\b/);
    }
  });

  it("writes one fact, two facts and none cleanly", () => {
    expect(openingSentence(plan("Oakhollow Arc Floor Lamp", [{ label: "Bulb", value: "E27" }]))).toBe("Key specifications of the Oakhollow Arc Floor Lamp include E27 bulb.");
    expect(openingSentence(plan("Oakhollow Arc Floor Lamp", [{ label: "Bulb", value: "E27" }, { label: "Shade material", value: "linen" }]))).toBe(
      "Key specifications of the Oakhollow Arc Floor Lamp include E27 bulb and linen shade material.",
    );
    // Nothing reads well in a sentence: only the name, and no claim.
    expect(openingSentence(plan("Kestrel Ridge Slim Fit Jeans", [{ label: "Item weight", value: "450 g" }]))).toBe("This listing is for the Kestrel Ridge Slim Fit Jeans.");
    // A name that starts with its own article is not given another.
    expect(identitySentence("The Night Garden Candle")).toBe("This listing is for The Night Garden Candle.");
  });

  it("leaves no dangling joiner, stray punctuation or doubled space when facts are filtered", () => {
    const facts = [
      { label: "Chipset manufacturer", value: "Aurora Labs" },
      { label: "Memory", value: "12GB GDDR7," },
      { label: "Directions", value: "Seat firmly" },
      { label: "Item weight", value: "1.2 kg" },
      { label: "Boost Clock", value: "2685 MHz" },
    ];
    for (const text of [openingSentence(plan("Tessera  Vx-70   Graphics Card", facts)), factMetaSentence(plan("Tessera  Vx-70   Graphics Card", facts))]) {
      // The company, the weight, the instruction and the value with a stray comma are all left out; nothing dangles.
      expect(text).toBe("Key specifications of the Tessera Vx-70 Graphics Card include 2685 MHz boost clock.");
      expect(text).not.toMatch(/\s{2}|\s[,.]|,\.|\band and\b|, and\.|\band\.$/);
      expect(text.match(/\./g)?.length).toBe(1);
    }
    // With one fact left there is no "and" at all.
    expect(openingSentence(plan("Tessera Vx-70", facts.slice(0, 2)))).not.toMatch(/\band\b/);
  });

  it("says 'key features' when staff's own lines stand in, and states a use without a verb on the name", () => {
    expect(factMetaSentence(plan("Kestrel Ridge Slim Fit Jeans", []), { extra: ["stretch denim", "five pockets"] })).toBe(
      "Key features of the Kestrel Ridge Slim Fit Jeans include stretch denim and five pockets.",
    );
    expect(factMetaSentence(plan("Oakhollow Arc Floor Lamp", [{ label: "Bulb", value: "E27" }]), { use: "reading corners." })).toBe(
      "Key specifications of the Oakhollow Arc Floor Lamp, intended for reading corners, include E27 bulb.",
    );
  });

  it("names the product once, in the opening, and adds a bare identity sentence only when nothing else names it", () => {
    const product = input({
      title: "Brightwave Pulse 2 Headphones",
      brand: "Brightwave",
      details: { modelName: "Pulse 2" },
      knowledge: knowledge([{ label: "Bluetooth", value: "5.3" }, { label: "Battery life", value: "40 hours" }]),
    });
    const research = { siteSearch: null, keywordMetrics: [], serp: [] };
    const base = sanitizeGenerated(generateByRules(product, research), product);
    const gate = (html: string) =>
      applyQualityGate({ ...structuredClone(base), description: { improvements: [], suggestedHtml: html } } as GeneratedRecommendations, product, () => base).generated.description.suggestedHtml ?? "";

    const text = gate("<p>Lightweight and stunning, it turns heads. It pairs over Bluetooth 5.3 and lasts 40 hours. The Brightwave Pulse 2 Headphones fold flat.</p>");
    const first = sentences(text.replace(/<[^>]+>/g, " ").trim())[0];
    expect(first).toMatch(/^Key specifications of the Brightwave Pulse 2 Headphones include /);
    expect(text.split("Brightwave Pulse 2 Headphones").length - 1).toBe(1);

    // No fact reads well, but the paragraph already names the product: no bare sentence is added.
    const bare = input({ title: "Brightwave Pulse 2 Headphones", brand: "Brightwave", details: { modelName: "Pulse 2" } });
    const bareBase = sanitizeGenerated(generateByRules(bare, research), bare);
    const bareGate = (html: string) =>
      applyQualityGate({ ...structuredClone(bareBase), description: { improvements: [], suggestedHtml: html } } as GeneratedRecommendations, bare, () => bareBase).generated.description.suggestedHtml ?? "";
    const named = bareGate("<p>It folds flat into its case. The Brightwave Pulse 2 Headphones pair over Bluetooth.</p>");
    expect(named).not.toMatch(/This listing is for/);
    const unnamed = bareGate("<p>It folds flat into its case. It pairs over Bluetooth in seconds.</p>");
    expect(unnamed.startsWith("<p>This listing is for the Brightwave Pulse 2 Headphones. ")).toBe(true);
  });

  it("builds the opening from the content plan, with no second model call", () => {
    const product = input({ knowledge: knowledge(FACTS, { family: "Graphics Cards" }) });
    expect(openingSentence(contentPlan(product))).toBe(`Key specifications of the ${product.title} include 12GB GDDR7 memory and 2685 MHz boost clock.`);
  });
});
