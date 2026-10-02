/**
 * D-128: product data quality and SeoPulse content quality — the deterministic
 * rules, tested directly with synthetic products from unrelated families.
 * None of these rules knows any brand; the fixtures are invented.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_GROUNDED, type GroundedKnowledge } from "@/lib/pkb/publish";
import { candidateRejection, isDecorationOnly, stripDecoration } from "@/lib/pkb/candidate-quality";
import {
  actionTargets,
  allVisibleSelected,
  batches,
  decideInBatches,
  decisionMessage,
  selectAllVisible,
  visibleClaims,
} from "@/lib/pkb/claim-selection";
import {
  detectLanguage,
  englishAlternates,
  htmlLanguage,
  structuredDataLanguage,
  urlLanguagePreference,
} from "@/lib/pkb/language";
import { collapseRepeatedUnits, valueWithUnit } from "@/lib/pkb/unit-text";
import { isWarrantyCandidate, isWarrantyLabel, mentionsWarranty } from "@/lib/pkb/warranty-policy";
import { SKU_MAX_LENGTH, skuBase, uniqueSku } from "@/lib/catalog/sku-generator";
import { atAGlance, contentPlan, keyPointFromFact, prioritizedFacts } from "@/lib/seo-pulse/content-plan";
import { applyQualityGate, fitMetaDescription, sentenceProblem, wellFormed, withoutPraise } from "@/lib/seo-pulse/quality";
import { generateByRules } from "@/lib/seo-pulse/rules";
import { sanitizeGenerated } from "@/lib/seo-pulse/sanitize";
import type { GeneratedRecommendations, SeoPulseInput } from "@/lib/seo-pulse/types";

// ------------------------------------------------------------ fixtures

function knowledge(rows: { label: string; value: string; unit?: string | null }[], family?: { name: string; labels: string[] }): GroundedKnowledge {
  return {
    ...EMPTY_GROUNDED,
    attributes: rows.map((row, index) => ({
      key: `k${index}`,
      label: row.label,
      value: row.value,
      unit: row.unit ?? null,
      pkbVariantId: null,
      state: "VERIFIED",
    })),
    family: family
      ? { id: "f1", name: family.name, attributes: family.labels.map((label, index) => ({ key: `f${index}`, label, requirement: index < 2 ? "required" : "recommended" })) }
      : null,
  } as GroundedKnowledge;
}

function input(overrides: Partial<SeoPulseInput> = {}): SeoPulseInput {
  return {
    productId: "00000000-0000-4000-8000-000000000001",
    knowledge: EMPTY_GROUNDED,
    title: "Tessera Vx-70 Graphics Card 12GB",
    slug: "tessera-vx-70-graphics-card-12gb",
    brand: "Tessera",
    sku: null,
    identifierType: null,
    identifierValue: null,
    categoryId: "00000000-0000-4000-8000-000000000002",
    categoryPath: ["Components"],
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

const graphics = () =>
  input({
    knowledge: knowledge(
      [
        { label: "Architecture", value: "Aurora" },
        { label: "Memory", value: "12GB GDDR7" },
        { label: "Shader Cores", value: "6,144" },
        { label: "Boost Clock", value: "2685 MHz", unit: "MHz" },
        { label: "Memory Speed", value: "28 Gbps", unit: "Gbps" },
        { label: "Cooling", value: "Triple fan" },
        { label: "Interface", value: "PCIe 5.0" },
        { label: "Card Dimensions", value: "11.80 × 4.73 × 1.9 in" },
        { label: "Warranty", value: "3-year limited warranty" },
      ],
      { name: "Graphics cards", labels: ["Architecture", "Memory", "Shader Cores", "Boost Clock", "Cooling", "Interface"] },
    ),
  });

const perfume = () =>
  input({
    title: "Maison Lune Nuit Eau de Parfum 50 ml",
    slug: "maison-lune-nuit-eau-de-parfum-50-ml",
    brand: "Maison Lune",
    knowledge: knowledge(
      [
        { label: "Concentration", value: "Eau de Parfum" },
        { label: "Size", value: "50 ml" },
        { label: "Top notes", value: "Bergamot, pink pepper" },
      ],
      { name: "Fragrance", labels: ["Concentration", "Size", "Top notes"] },
    ),
  });

const research = { siteSearch: null, keywordMetrics: [], serp: [] };

function answer(overrides: Partial<GeneratedRecommendations> = {}, base = graphics()): GeneratedRecommendations {
  const rules = sanitizeGenerated(generateByRules(base, research), base);
  return { ...structuredClone(rules), ...overrides };
}

// ---------------------------------------------------- 1. units (1–10)

describe("a value and its unit", () => {
  it("never writes a unit twice, and adds a missing one once", () => {
    expect(valueWithUnit("2685 MHz", "MHz")).toBe("2685 MHz");
    expect(valueWithUnit("2685", "MHz")).toBe("2685 MHz");
    expect(valueWithUnit("28 Gbps", "Gbps")).toBe("28 Gbps");
    expect(valueWithUnit("12GB", "GB")).toBe("12GB");
    expect(valueWithUnit("12 GB", "gb")).toBe("12 GB");
    expect(collapseRepeatedUnits("Boost clock 2685 MHz MHz")).toBe("Boost clock 2685 MHz");
    expect(collapseRepeatedUnits("28 Gbps Gbps and 5 V V")).toBe("28 Gbps and 5 V");
  });

  it("keeps technical symbols, dimensions, ranges and compound values as they are", () => {
    expect(valueWithUnit("32", "Ω")).toBe("32 Ω");
    expect(valueWithUnit("32 Ω", "Ω")).toBe("32 Ω");
    expect(collapseRepeatedUnits("32 Ω Ω")).toBe("32 Ω");
    expect(valueWithUnit("5", "µm")).toBe("5 µm");
    expect(valueWithUnit("0–100°C", "°C")).toBe("0–100°C");
    expect(collapseRepeatedUnits("25 °C °C")).toBe("25 °C");
    expect(valueWithUnit("±5%", "%")).toBe("±5%");
    expect(valueWithUnit("11.8 × 4.7 × 1.9 in", "in")).toBe("11.8 × 4.7 × 1.9 in");
    expect(valueWithUnit("2 × USB-C", null)).toBe("2 × USB-C");
    expect(valueWithUnit("7.97 ounces (226 grams)", "g")).toBe("7.97 ounces (226 grams)");
    expect(valueWithUnit("1.2e3", "rpm")).toBe("1.2e3 rpm");
    // Repeated words that are not a unit after a number are left alone.
    expect(collapseRepeatedUnits("Dolby Dolby Atmos")).toBe("Dolby Dolby Atmos");
    expect(collapseRepeatedUnits("5 m mode")).toBe("5 m mode");
  });
});

// --------------------------------------------- 2. junk and spec quality (11–18)

describe("what may become candidate knowledge", () => {
  it("rejects calls to action, navigation and promotional modules", () => {
    expect(candidateRejection("Shop Now", "Buy today")?.code).toBe("SOURCE_NOISE");
    expect(candidateRejection("Get Educated", "Make informed decisions with expert advice. Learn More")?.code).toBe("SOURCE_NOISE");
    expect(candidateRejection("Learn More", "Read details")?.code).toBe("SOURCE_NOISE");
    expect(candidateRejection("Customer Support", "Contact us")?.code).toBe("SOURCE_NOISE");
    expect(candidateRejection("Find a Store", "Locate a retailer")?.code).toBe("SOURCE_NOISE");
    expect(candidateRejection("Newsletter", "Sign up for offers")?.code).toBe("SOURCE_NOISE");
    expect(candidateRejection("Our story", "We believe you deserve better gear for every adventure you take")?.code).toBe("NOT_A_SPECIFICATION");
    expect(candidateRejection("Manual", "https://example.test/manual.pdf")?.code).toBe("SOURCE_NOISE");
  });

  it("rejects decoration, and keeps technical symbols", () => {
    expect(candidateRejection("✓", "★★★★★")?.code).toBe("DECORATIVE");
    expect(candidateRejection("🔥 Hot", "🚀")?.code).toBe("DECORATIVE");
    expect(isDecorationOnly("✓ 🔥")).toBe(true);
    expect(stripDecoration("✓ Impedance: 32 Ω ±1% @ 25 °C × 2 — µm Brand® Line™")).toBe("Impedance: 32 Ω ±1% @ 25 °C × 2 — µm Brand® Line™");
  });

  it("keeps real specifications, numeric or not", () => {
    for (const [label, value] of [
      ["Boost Clock", "2685 MHz"],
      ["Architecture", "Blackwell"],
      ["CUDA Cores", "6144"],
      ["Memory", "12GB GDDR7"],
      ["Card Dimensions", "11.80 × 4.73 × 1.9 in"],
      ["Color", "Black"],
      ["Material", "Leather"],
      ["Concentration", "Eau de Parfum"],
      ["USB", "USB-C"],
      ["Intended use", "Home"],
      ["Region", "US"],
      ["Support", "Windows, macOS"],
      ["Wireless charging", "No"],
    ]) {
      expect(candidateRejection(label, value), `${label}: ${value}`).toBeNull();
    }
  });

  it("keeps an unfamiliar but plausible row for a person to decide", () => {
    expect(candidateRejection("Heel-to-toe drop", "8 mm")).toBeNull();
    expect(candidateRejection("Sillage", "Moderate")).toBeNull();
    expect(candidateRejection("Ingredients", "Aqua, glycerin, niacinamide, panthenol, sodium hyaluronate")).toBeNull();
  });
});

// --------------------------------------------------------- 3. warranty (19–26)

describe("the warranty policy", () => {
  it("recognises a warranty however a source phrases it", () => {
    expect(isWarrantyLabel("Warranty")).toBe(true);
    expect(isWarrantyLabel("Manufacturer Warranty")).toBe(true);
    expect(isWarrantyLabel("Guarantee")).toBe(true);
    expect(isWarrantyCandidate("Support", "3-year limited warranty")).toBe(true);
    expect(isWarrantyCandidate("Returns", "Money-back guarantee")).toBe(true);
    expect(mentionsWarranty("Backed by a limited lifetime warranty.")).toBe(true);
    expect(isWarrantyCandidate("Memory", "12GB GDDR7")).toBe(false);
    expect(candidateRejection("Warranty", "3 years")?.code).toBe("WARRANTY_EXTERNAL");
  });

  it("keeps a researched warranty out of what SeoPulse writes from, At a Glance and Key Points", () => {
    const product = graphics();
    const facts = prioritizedFacts(product);
    expect(facts.some((row) => /warrant/i.test(row.label))).toBe(false);
    expect(atAGlance(facts).some((row) => /warrant/i.test(row.label))).toBe(false);
    expect(contentPlan(product).manualWarranty).toBeNull();
    const gated = applyQualityGate(
      answer({ keyFeatures: ["3-year limited warranty", "12GB GDDR7 memory"], description: { improvements: [], suggestedHtml: "<p>The Tessera Vx-70 Graphics Card 12GB has 12GB GDDR7 memory. It comes with a 3-year warranty.</p>" } }),
      product,
      () => answer(),
    ).generated;
    expect(JSON.stringify([gated.keyFeatures, gated.description.suggestedHtml])).not.toMatch(/warrant/i);
  });

  it("lets SeoPulse state the listing's own manual warranty, and only that", () => {
    const product = input({ ...graphics(), warranty: { hasWarranty: true, durationMonths: 24 } });
    expect(contentPlan(product).manualWarranty).toBe("24-month warranty");
    const gated = applyQualityGate(
      answer({ keyFeatures: ["24-month warranty from Manifest"] }, product),
      product,
      () => answer({}, product),
    ).generated;
    expect(gated.keyFeatures).toContain("24-month warranty from Manifest");
  });
});

// --------------------------------------------- 4. At a Glance and Key Points (27–32)

describe("At a Glance and Key Points", () => {
  it("At a Glance is short label → value facts, the family's first", () => {
    const glance = atAGlance(prioritizedFacts(graphics()), { priority: ["Architecture", "Memory", "Shader Cores", "Boost Clock", "Cooling", "Interface"] });
    expect(glance.map((row) => row.label)).toEqual(["Architecture", "Memory", "Shader Cores", "Boost Clock", "Cooling"]);
    expect(glance.every((row) => row.value.length <= 40)).toBe(true);
    expect(glance.find((row) => row.label === "Boost Clock")?.value).toBe("2685 MHz");
  });

  it("Key Points read as a shopper reads, never the same Label: value line", () => {
    expect(keyPointFromFact("Memory", "12GB GDDR7")).toBe("12GB GDDR7 memory");
    expect(keyPointFromFact("Architecture", "Aurora")).toBe("Aurora architecture");
    expect(keyPointFromFact("Shader Cores", "6,144")).toBe("6,144 shader cores");
    expect(keyPointFromFact("Wireless charging", "Yes")).toBe("Wireless charging");
    expect(keyPointFromFact("Wireless charging", "No")).toBeNull();
    expect(keyPointFromFact("Switch type", "Linear mechanical switches")).toBe("Linear mechanical switches");
    const product = graphics();
    const gated = applyQualityGate(answer({ keyFeatures: ["Memory: 12GB GDDR7", "Cooling: Triple fan"] }), product, () => answer()).generated;
    expect(gated.keyFeatures).toEqual(["12GB GDDR7 memory", "Triple fan cooling"]);
    const glance = new Set(atAGlance(prioritizedFacts(product)).map((row) => `${row.label}: ${row.value}`));
    expect(gated.keyFeatures.some((line) => glance.has(line))).toBe(false);
    // A label the facts do not use is rewritten too (live: facts said "Memory Size").
    const other = applyQualityGate(answer({ keyFeatures: ["Video Memory: 12GB GDDR7"] }), product, () => answer()).generated;
    expect(other.keyFeatures).toEqual(["12GB GDDR7 video memory"]);
  });

  it("never turns a plain fact into an unsupported benefit", () => {
    const product = graphics();
    const gated = applyQualityGate(answer({ keyFeatures: ["Exceptional cooling performance", "Triple fan cooling"] }), product, () => answer()).generated;
    expect(gated.keyFeatures).toEqual(["Triple fan cooling"]);
  });

  it("works the same for an unrelated family, and a simple product gets no technical sections", () => {
    const plan = contentPlan(perfume());
    expect(plan.atAGlance.map((row) => row.label)).toEqual(["Concentration", "Size", "Top notes"]);
    expect(plan.depth).toBe("simple");
    expect(plan.sections.join(" ")).not.toMatch(/connectivity|compatib/i);
    const detailed = contentPlan(graphics());
    expect(detailed.sections.join(" ")).toMatch(/build|connectivity/i);
  });
});

// ---------------------------------------------------- 5. bulk selection (33–36, 43)

describe("choosing many proposed values at once", () => {
  const claims = [
    { id: "a", status: "SUGGESTED" },
    { id: "b", status: "CONFLICT" },
    { id: "c", status: "ACCEPTED" },
    { id: "d", status: "SUGGESTED" },
    { id: "e", status: "REJECTED" },
  ];

  it("selects only what is shown and can still be decided", () => {
    const all = visibleClaims(claims, "all");
    expect(all.map((claim) => claim.id)).toEqual(["a", "b", "d"]);
    const proposed = visibleClaims(claims, "proposed");
    expect([...selectAllVisible(new Set(), proposed)]).toEqual(["a", "d"]);
    expect(allVisibleSelected(new Set(["a", "d"]), proposed)).toBe(true);
    expect(allVisibleSelected(new Set(["a"]), proposed)).toBe(false);
  });

  it("acts only on what is selected and shown, so a hidden selection is never decided", () => {
    const selected = new Set(["a", "b", "d"]);
    expect(actionTargets(selected, visibleClaims(claims, "proposed"))).toEqual(["a", "d"]);
    expect(actionTargets(new Set(), visibleClaims(claims, "all"))).toEqual([]);
  });

  it("sends at most 100 at a time and stops at the first refusal, saying what happened", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    expect(batches(ids).map((batch) => batch.length)).toEqual([100, 100, 50]);
    const sent: number[] = [];
    const outcome = await decideInBatches(ids, async (batch) => {
      sent.push(batch.length);
      return sent.length === 2 ? { ok: false, error: "That claim is already accepted." } : { ok: true };
    });
    expect(sent).toEqual([100, 100]);
    expect(outcome).toEqual({ decided: 100, failed: 150, error: "That claim is already accepted." });
    // A plain accept never reads as verification.
    expect(decisionMessage("accept", outcome)).toBe("Accepted 100 values as unverified. 150 not decided — nothing in that group was changed: That claim is already accepted.");
    expect(decisionMessage("verify", { decided: 2, failed: 0, error: null })).toBe("Accepted as verified 2 values.");
    expect(decisionMessage("reject", { decided: 3, failed: 0, error: null })).toBe("Rejected 3 values.");
  });
});

// ----------------------------------------------------------------- 6. SKU (45–53)

describe("generated SKUs", () => {
  const longTitle = "Tessera Vx-70 Aurora ARGB Epic-Z RGB OC Triple Fan 12GB GDDR7 Graphics Card With Extra Long Marketing Words";

  it("stays short and within 64 characters whatever the title", () => {
    const sku = skuBase({ brand: "Tessera", model: null, title: longTitle });
    expect(sku.length).toBeLessThanOrEqual(40);
    expect(sku.length).toBeLessThan(longTitle.length / 2);
    expect(sku).toBe("TESSERA-VX70");
    for (let words = 1; words < 80; words += 7) {
      const title = Array.from({ length: words }, (_, index) => `Word${index}Longword`).join(" ");
      expect(skuBase({ brand: "B".repeat(90), model: "M".repeat(90), title }, ["V".repeat(90), "W".repeat(90)]).length).toBeLessThanOrEqual(SKU_MAX_LENGTH);
    }
  });

  it("uses the model or part number when there is one, and variant values to tell variants apart", () => {
    expect(skuBase({ brand: "Tessera", model: "VX70-12G-OC", title: longTitle })).toBe("TESSERA-VX7012GOC");
    const black = skuBase({ brand: "Tessera", model: "VX70", title: longTitle }, ["Black", "12 GB"]);
    const white = skuBase({ brand: "Tessera", model: "VX70", title: longTitle }, ["White", "12 GB"]);
    expect(black).toBe("TESSERA-VX70-BLACK-12GB");
    expect(white).not.toBe(black);
  });

  it("gives a product without a model a stable short code", () => {
    const first = skuBase({ brand: "Maison Lune", title: "Maison Lune Nuit Eau de Parfum" });
    expect(first).toBe(skuBase({ brand: "Maison Lune", title: "Maison Lune Nuit Eau de Parfum" }));
    expect(first).toBe("MAISON-NUITEAU");
  });

  it("resolves a collision with a short numbered suffix, still within 64", () => {
    expect(uniqueSku("TESSERA-VX70", new Set(["TESSERA-VX70"]))).toBe("TESSERA-VX70-2");
    expect(uniqueSku("TESSERA-VX70", new Set(["TESSERA-VX70", "TESSERA-VX70-2"]))).toBe("TESSERA-VX70-3");
    const long = "X".repeat(64);
    const next = uniqueSku(long, new Set([long]));
    expect(next.length).toBeLessThanOrEqual(64);
    expect(next.endsWith("-2")).toBe(true);
  });

  it("is ASCII letters, digits and dashes, from any script", () => {
    const sku = skuBase({ brand: "Épée Ünïcode", title: "Crème Brûlée Kit 2" }, ["Bleu Océan", "日本"]);
    expect(sku).toMatch(/^[A-Z0-9-]+$/);
    expect(sku).toBe("EPEE-BRULEE2-BLEUOCEA");
    expect(skuBase({ brand: "日本", title: "中文" })).toBe("ITEM");
  });
});

// --------------------------------------------------------- 7. language (58–69)

describe("the language of a page", () => {
  const english =
    "The Tessera Vx-70 is a graphics card with 12GB of memory. It has three fans and is built for gaming and creative work. This card connects to your computer through PCIe 5.0 and supports up to four displays.";
  it("accepts English, declared or not", () => {
    expect(detectLanguage({ text: english, declared: ["en"] }).verdict).toBe("english");
    expect(detectLanguage({ text: english, declared: [] }).verdict).toBe("english");
  });

  it("refuses German, French, Spanish, Chinese, Japanese, Arabic and Bengali pages", () => {
    const pages: [string, string][] = [
      ["de", "Die Tessera Vx-70 ist eine Grafikkarte mit 12 GB Speicher. Sie hat drei Lüfter und ist für Spiele und kreative Arbeit gebaut. Die Karte wird über PCIe 5.0 mit dem Computer verbunden und unterstützt bis zu vier Bildschirme."],
      ["fr", "La Tessera Vx-70 est une carte graphique avec 12 Go de mémoire. Elle a trois ventilateurs et est conçue pour les jeux et le travail créatif. Cette carte se connecte à votre ordinateur par PCIe 5.0 et prend en charge jusqu'à quatre écrans."],
      ["es", "La Tessera Vx-70 es una tarjeta gráfica con 12 GB de memoria. Tiene tres ventiladores y está diseñada para juegos y trabajo creativo. Esta tarjeta se conecta a su ordenador por PCIe 5.0 y admite hasta cuatro pantallas."],
      ["zh", "Tessera Vx-70 是一款配备 12GB 显存的显卡。它有三个风扇，专为游戏和创意工作而设计。"],
      ["ja", "Tessera Vx-70 は 12GB のメモリを搭載したグラフィックスカードです。三つのファンを備えています。"],
      ["ar", "بطاقة الرسومات تيسيرا مزودة بذاكرة سعتها اثنا عشر جيجابايت وثلاث مراوح للتبريد."],
      ["bn", "টেসেরা একটি গ্রাফিক্স কার্ড যার বারো গিগাবাইট মেমরি এবং তিনটি ফ্যান রয়েছে।"],
    ];
    for (const [language, text] of pages) {
      const verdict = detectLanguage({ text, declared: [language] });
      expect(verdict.verdict, language).toBe("non_english");
    }
    // Official or not, a German page declared as German is refused.
    expect(detectLanguage({ text: pages[0][1], declared: [] }).verdict).toBe("non_english");
  });

  it("refuses a page declared English whose text is not", () => {
    const german = "Die Tessera Vx-70 ist eine Grafikkarte mit 12 GB Speicher. Sie hat drei Lüfter und ist für Spiele gebaut. Die Karte wird über PCIe 5.0 mit dem Computer verbunden.";
    expect(detectLanguage({ text: german, declared: ["en"] }).verdict).toBe("non_english");
  });

  it("keeps an English page with a few foreign navigation and footer words", () => {
    const mixed = `${english} Deutsch Français Español Italiano 日本語 Impressum Datenschutz`;
    expect(detectLanguage({ text: mixed, declared: ["en"] }).verdict).toBe("english");
  });

  it("does not guess when there is too little to tell", () => {
    expect(detectLanguage({ text: "Vx-70 12GB 2685 MHz PCIe 5.0", declared: [] }).verdict).toBe("uncertain");
    expect(detectLanguage({ text: "Vx-70 12GB 2685 MHz PCIe 5.0", declared: ["en-US"] }).verdict).toBe("english");
  });

  it("reads what a page declares, and the English versions it names", () => {
    expect(htmlLanguage('<html lang="de-DE"><body>')).toBe("de-DE");
    expect(structuredDataLanguage([{ "@type": "Product", inLanguage: "fr-FR" }])).toBe("fr-FR");
    const html = `<link rel="alternate" hreflang="de" href="/de/vx70"><link rel="alternate" hreflang="en-GB" href="/en-gb/vx70"><link rel="alternate" hreflang="en-US" href="https://tessera.test/en-us/vx70"><link rel="alternate" hreflang="x-default" href="/vx70">`;
    expect(englishAlternates(html, "https://tessera.test/de/vx70")).toEqual(["https://tessera.test/en-us/vx70", "https://tessera.test/en-gb/vx70"]);
  });

  it("ranks addresses by the locale they name, as a hint only", () => {
    expect(urlLanguagePreference("https://tessera.test/en-us/vx70")).toBe(1);
    expect(urlLanguagePreference("https://tessera.test/de/vx70")).toBe(-1);
    expect(urlLanguagePreference("https://tessera.test/products/vx70")).toBe(0);
  });

  it("does not count a product's own names as a language", () => {
    expect(detectLanguage({ text: `Le Tessera ${english}`, declared: [], ignore: ["Le Tessera"] }).verdict).toBe("english");
  });
});

// --------------------------------------------------- 8. SeoPulse quality (77–93)

describe("SeoPulse's quality gate", () => {
  const product = graphics();
  const title = product.title;

  it("uses the exact name once, and a shorter identity name after", () => {
    const html = `<p>The ${title} brings 12GB GDDR7 memory to your desk.</p><p>The ${title} uses Aurora architecture.</p><p>The ${title} connects through PCIe 5.0.</p>`;
    const product2 = input({ ...product, knowledge: { ...product.knowledge, brand: "Tessera", modelName: "Vx-70" } });
    const gated = applyQualityGate(answer({ description: { improvements: [], suggestedHtml: html } }, product2), product2, () => answer({}, product2)).generated;
    const text = gated.description.suggestedHtml ?? "";
    expect(text.split(title).length - 1).toBe(1);
    expect(text).toContain("Tessera Vx-70 uses Aurora architecture");
  });

  it("removes unsupported evaluation and sales filler, and keeps factual wording", () => {
    const html =
      "<p>The Tessera Vx-70 Graphics Card 12GB has 12GB GDDR7 memory and a triple fan cooler. It delivers exceptional cooling performance and clear, immersive visuals. Upgrade your setup today! It uses a PCIe 5.0 interface.</p>";
    const gated = applyQualityGate(answer({ description: { improvements: [], suggestedHtml: html } }), product, () => answer());
    const text = gated.generated.description.suggestedHtml ?? "";
    expect(text).toContain("12GB GDDR7 memory and a triple fan cooler");
    expect(text).toContain("PCIe 5.0 interface");
    expect(text).not.toMatch(/exceptional|immersive|upgrade your setup/i);
    expect(gated.repaired.join(" ")).toMatch(/unsupported claim|sales filler/);
    expect(sentenceProblem("Get yours now.", { factText: "", names: [], manualWarranty: false })).toBe("sales filler");
    expect(sentenceProblem("Designed to impress with premium build.", { factText: "", names: [], manualWarranty: false })).toMatch(/unsupported claim/);
  });

  it("refuses an 'Experience the …' opener, 'high-performance' and praise used as search terms (live acceptance)", () => {
    const none = { factText: "", names: [], manualWarranty: false };
    expect(sentenceProblem(`Experience the power of the ${title}.`, none)).toBe("sales filler");
    expect(sentenceProblem("Discover the difference a triple fan makes.", none)).toBe("sales filler");
    // Not an opener: a sentence that only contains the word stays.
    expect(sentenceProblem("It is rated for years of gaming experience.", none)).toBeNull();
    expect(sentenceProblem("A high-performance graphics card for gaming.", none)).toMatch(/unsupported claim/);
    expect(sentenceProblem(`High-End ${title}`, none)).toMatch(/unsupported claim/);

    const gated = applyQualityGate(
      answer({
        metaDescription: { recommended: `Experience the power of the ${title}.`, reason: "" },
        tags: ["graphics card", "high end", "gaming"],
        seoTitle: { recommended: title, alternatives: [title, `High-End ${title}`], reason: "" },
      }),
      product,
      () => answer(),
    );
    expect(gated.generated.metaDescription.recommended).not.toMatch(/experience the power/i);
    expect(gated.generated.tags).toEqual(["graphics card", "gaming"]);
    expect(gated.generated.seoTitle.alternatives).toEqual([title]);
  });

  it("takes praise out of a sentence rather than losing the sentence that names the product", () => {
    const none = { factText: "", names: [], manualWarranty: false };
    expect(withoutPraise("It is a high-performance graphics card for gaming.", none)).toBe("It is a graphics card for gaming.");
    expect(withoutPraise("It has an exceptional triple fan cooler.", none)).toBe("It has a triple fan cooler.");
    expect(withoutPraise("It has a premium aluminium body.", none)).toBe("It has an aluminium body.");
    expect(withoutPraise("A premium aluminium body.", none)).toBeNull();
    expect(withoutPraise("Exceptional cooling keeps the card at 70 °C.", none)).toBe("Cooling keeps the card at 70 °C.");
    // Cannot be taken out cleanly: dropped as before.
    expect(withoutPraise("It is exceptional.", none)).toBeNull();
    expect(withoutPraise("It gives clear and immersive visuals.", none)).toBeNull();
    expect(withoutPraise("It fits most standard cases.", none)).toBeNull();
    // From live output: praise after a joiner or a degree word cannot simply go.
    expect(withoutPraise("It is a compact yet powerful addition to your system.", none)).toBeNull();
    expect(withoutPraise("Connect more monitors for a more immersive gaming experience.", none)).toBeNull();
    expect(sentenceProblem("It runs the latest games smoothly.", none)).toMatch(/unsupported claim/);
    expect(withoutPraise("Perfect for 4K gaming and virtual reality applications.", none)).toBeNull();
    expect(withoutPraise("It is ideal for small rooms.", none)).toBeNull();
    expect(withoutPraise("Buy a premium card today.", none)).toBeNull();

    const html = `<p>The ${title} is a high-performance graphics card with 12GB GDDR7 memory. It is exceptional.</p>`;
    const gated = applyQualityGate(answer({ description: { improvements: [], suggestedHtml: html } }), product, () => answer());
    expect(gated.generated.description.suggestedHtml).toBe(`<p>The ${title} is a graphics card with 12GB GDDR7 memory.</p>`);
    expect(gated.repaired.join(" ")).toMatch(/unsupported claim/);
  });

  it("does not count a brand's own words as praise", () => {
    const branded = input({ ...product, brand: "Advanced Tessera" });
    const gated = applyQualityGate(answer({ brandVariations: ["advanced tessera"] }, branded), branded, () => answer({}, branded));
    expect(gated.generated.brandVariations).toEqual(["advanced tessera"]);
  });

  it("allows an evaluative word the facts themselves use", () => {
    const light = input({ ...perfume(), knowledge: knowledge([{ label: "Design", value: "Lightweight travel spray" }, { label: "Size", value: "50 ml" }]) });
    expect(sentenceProblem("A lightweight travel spray.", { factText: "design lightweight travel spray", names: [], manualWarranty: false })).toBeNull();
    const gated = applyQualityGate(answer({ keyFeatures: ["Lightweight travel spray"] }, light), light, () => answer({}, light)).generated;
    expect(gated.keyFeatures).toContain("Lightweight travel spray");
  });

  it("does not restate one fact a third time", () => {
    const html =
      "<p>It has 12GB GDDR7 memory.</p><p>The 12GB GDDR7 memory helps with large textures.</p><p>With 12GB GDDR7 on board, it handles big scenes.</p><p>It runs on Aurora architecture.</p>";
    const text = applyQualityGate(answer({ description: { improvements: [], suggestedHtml: html } }), product, () => answer()).generated.description.suggestedHtml ?? "";
    expect(text.split("12GB GDDR7").length - 1).toBe(2);
    expect(text).toContain("Aurora architecture");
  });

  it("repairs doubled units and drops foreign-language sentences, keeping proper names", () => {
    const html = "<p>The Tessera Vx-70 boosts to 2685 MHz MHz with 28 Gbps Gbps memory. Die Karte ist für Spiele und kreative Arbeit gebaut und hat drei Lüfter.</p>";
    const text = applyQualityGate(answer({ description: { improvements: [], suggestedHtml: html } }), product, () => answer()).generated.description.suggestedHtml ?? "";
    expect(text).toContain("2685 MHz with 28 Gbps memory");
    expect(text).not.toMatch(/MHz MHz|Gbps Gbps|Karte/);
    expect(text).toContain("Tessera Vx-70");
  });

  it("withholds a description that cannot be repaired, and keeps the other fields", () => {
    const broken = applyQualityGate(answer({ description: { improvements: [], suggestedHtml: "<p>Shop now!</p><ul><li>Don't miss out</li></ul>" } }), product, () => answer());
    expect(broken.generated.description.suggestedHtml).toBeNull();
    expect(broken.withheld).toContain("description");
    expect(broken.generated.keyFeatures.length).toBeGreaterThan(0);
    expect(wellFormed("<p>One<ul><li>two</p></li></ul>")).toBe(false);
    expect(wellFormed("<p>One</p><ul><li>two</li></ul>")).toBe(true);
  });

  it("removes empty headings and lists", () => {
    const html = "<p>The Tessera Vx-70 has 12GB GDDR7 memory and Aurora architecture.</p><h2>Why it stands out</h2><ul><li>Unleash amazing power</li></ul><h2>Specs</h2>";
    const text = applyQualityGate(answer({ description: { improvements: [], suggestedHtml: html } }), product, () => answer()).generated.description.suggestedHtml ?? "";
    expect(text).toBe("<p>The Tessera Vx-70 has 12GB GDDR7 memory and Aurora architecture.</p>");
  });

  it("ends the meta description naturally, never mid-word, never on a comma", () => {
    const long =
      "Tessera Vx-70 Graphics Card 12GB with Aurora architecture, 12GB GDDR7 memory, 6,144 shader cores, a 2685 MHz boost clock, triple fan cooling, PCIe 5.0 and support for four displays and";
    const fitted = fitMetaDescription(long, 160);
    expect(fitted.length).toBeLessThanOrEqual(161);
    expect(fitted).toMatch(/[.!?]$/);
    expect(fitted).not.toMatch(/,\.$|\band\.$/);
    expect(long.startsWith(fitted.slice(0, -1))).toBe(true);
    expect(fitMetaDescription("Short and complete.")).toBe("Short and complete.");
    expect(fitMetaDescription("Two sentences here. The second one is also here.", 25)).toBe("Two sentences here.");
    const gated = applyQualityGate(answer({ metaDescription: { recommended: `${long}. Shop now!`, reason: "x" } }), product, () => answer()).generated;
    expect(gated.metaDescription.recommended).not.toMatch(/shop now/i);
    expect(gated.metaDescription.recommended).toMatch(/[.!?]$/);
  });

  it("replaces a stuffed or promotional title with the rules title", () => {
    const stuffed = applyQualityGate(answer({ seoTitle: { recommended: "Vx-70 Graphics Card Graphics Card Best Graphics Card", alternatives: [], reason: "x" } }), product, () => answer());
    expect(stuffed.withheld).toContain("SEO title");
    expect(stuffed.generated.seoTitle.recommended).not.toMatch(/best/i);
  });

  it("keeps a simple product's description short and a detailed one's depth", () => {
    const simple = contentPlan(perfume());
    const detailed = contentPlan(graphics());
    expect(simple.usefulWords).toMatch(/120/);
    expect(detailed.facts.length).toBeGreaterThan(simple.facts.length);
    expect(detailed.depth).not.toBe("simple");
    // Nothing is padded: a short, true description stands.
    const short = applyQualityGate(answer({ description: { improvements: [], suggestedHtml: "<p>Maison Lune Nuit is an eau de parfum in a 50 ml bottle.</p>" } }, perfume()), perfume(), () => answer({}, perfume()));
    expect(short.generated.description.suggestedHtml).toBe("<p>Maison Lune Nuit is an eau de parfum in a 50 ml bottle.</p>");
  });

  it("drops non-English and warranty search terms, keeping the product's names", () => {
    const gated = applyQualityGate(
      answer({ tags: ["graphics card", "显卡", "warranty"], searchAliases: ["vx70", "tessera vx 70"] }),
      product,
      () => answer(),
    ).generated;
    expect(gated.tags).toEqual(["graphics card"]);
    expect(gated.searchAliases).toEqual(["vx70", "tessera vx 70"]);
  });
});
