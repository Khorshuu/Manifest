/**
 * D-129: SeoPulse content polish — SEO titles shortened by meaning, an opening
 * that names the product, sentences with nothing to say, and a meta
 * description written as one sentence. All deterministic; every fixture is an
 * invented product from an unrelated family, and no rule names a brand.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMPTY_GROUNDED, type GroundedKnowledge } from "@/lib/pkb/publish";
import { contentPlan, factMetaSentence, openingSentence, sentenceFacts } from "@/lib/seo-pulse/content-plan";
import { applyQualityGate, sentenceProblem, thinSentence, withoutGenericPredicates } from "@/lib/seo-pulse/quality";
import { generateByRules } from "@/lib/seo-pulse/rules";
import { sanitizeGenerated } from "@/lib/seo-pulse/sanitize";
import { sentences } from "@/lib/seo-pulse/text";
import { urlLanguagePreference } from "@/lib/pkb/language";
import { fitSeoTitle, SEO_TITLE_MAX, SEO_TITLE_TARGET, titleIdentity, type TitleIdentity } from "@/lib/seo-pulse/title-fit";
import type { GeneratedRecommendations, SeoPulseInput } from "@/lib/seo-pulse/types";

// ------------------------------------------------------------ fixtures

function knowledge(
  rows: { label: string; value: string }[],
  options: { family?: { name: string; labels: string[] }; brand?: string; modelName?: string } = {},
): GroundedKnowledge {
  return {
    ...EMPTY_GROUNDED,
    brand: options.brand ?? null,
    modelName: options.modelName ?? null,
    attributes: rows.map((row, index) => ({ key: `k${index}`, label: row.label, value: row.value, unit: null, pkbVariantId: null, state: "VERIFIED" })),
    family: options.family
      ? {
          id: "f1",
          name: options.family.name,
          attributes: options.family.labels.map((label, index) => ({ key: `f${index}`, label, requirement: index < 2 ? "required" : "recommended" })),
        }
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

const CARD_FACTS = [
  { label: "Architecture", value: "Aurora" },
  { label: "Memory", value: "12GB GDDR7" },
  { label: "Shader Cores", value: "6,144" },
  { label: "Boost Clock", value: "2685 MHz" },
  { label: "Cooling", value: "Triple fan" },
  { label: "Interface", value: "PCIe 5.0" },
  { label: "Warranty", value: "3-year limited warranty" },
];
const CARD_FAMILY = { name: "Graphics cards", labels: ["Architecture", "Memory", "Shader Cores", "Boost Clock", "Cooling", "Interface"] };

const graphics = (overrides: Partial<SeoPulseInput> = {}) => input({ knowledge: knowledge(CARD_FACTS, { family: CARD_FAMILY }), ...overrides });

const research = { siteSearch: null, keywordMetrics: [], serp: [] };

function answer(base: SeoPulseInput, overrides: Partial<GeneratedRecommendations> = {}): GeneratedRecommendations {
  const rules = sanitizeGenerated(generateByRules(base, research), base);
  return { ...structuredClone(rules), ...overrides };
}

function gate(base: SeoPulseInput, overrides: Partial<GeneratedRecommendations>) {
  return applyQualityGate(answer(base, overrides), base, () => answer(base));
}

const describeHtml = (html: string): Partial<GeneratedRecommendations> => ({ description: { improvements: [], suggestedHtml: html } });

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

// ------------------------------------------------ 1. SEO titles (1–11)

const LONG_CARD = "Tessera Vx-70 Nova-X RGB OC Triple Fan Silent Cooling 12GB GDDR7 Graphics Card";
const CARD_IDENTITY = identity({
  brand: "Tessera",
  model: "Vx-70 Nova-X RGB OC Triple Fan",
  productType: ["Graphics cards"],
  factText: "12gb gddr7 triple fan",
});

describe("SEO titles shortened by meaning, not cut at a character count (D-129)", () => {
  it("fits a long name within the title limit, aiming to leave room for the site's name", () => {
    const fitted = fitSeoTitle(LONG_CARD, CARD_IDENTITY);
    expect(LONG_CARD.length).toBeGreaterThan(SEO_TITLE_MAX);
    expect(fitted.length).toBeLessThanOrEqual(SEO_TITLE_TARGET);
    expect(fitted).toBe("Tessera Vx-70 Nova-X RGB OC 12GB Graphics Card");
  });

  it("never cuts inside a word, a model number, or between a number and its unit", () => {
    const names = [
      LONG_CARD,
      "Maison Lune Nuit Intense Extrait Eau de Parfum Spray for Women 100 ml",
      "Kestrel Ridgeline 3 Men's Waterproof Leather Hiking Boots with Vibram Outsole Size 10 Brown",
      "Oakhollow Solid Walnut Extendable Dining Table for Six to Eight People with Two Leaves 180 x 90 cm",
    ];
    for (const name of names) {
      const fitted = fitSeoTitle(name, identity({ brand: name.split(" ")[0] }));
      expect(fitted.length).toBeLessThanOrEqual(SEO_TITLE_MAX);
      expect(wholeWordsInOrder(fitted, name)).toBe(true);
      // Never a dangling joiner or a bare "x" at the end.
      expect(fitted).not.toMatch(/\b(?:and|with|for|of|to|x)$/i);
    }
    // "12 GB" stays together even when split by a space.
    const spaced = fitSeoTitle("Tessera Vx-70 Nova-X Silent Triple Fan Cooling Edition 12 GB GDDR7 Graphics Card", CARD_IDENTITY);
    expect(spaced).toMatch(/12 GB/);
  });

  it("does not end on half of the product type when a cleaner shortening exists", () => {
    const fitted = fitSeoTitle(LONG_CARD, CARD_IDENTITY);
    expect(fitted.endsWith("Graphics Card")).toBe(true);
    // Without a family or category, the type at the end of the name is still kept whole.
    const bare = fitSeoTitle(LONG_CARD, { ...CARD_IDENTITY, productType: [] });
    expect(bare.endsWith("Graphics Card")).toBe(true);
  });

  it("keeps the brand, the model and the variant's own values", () => {
    const fitted = fitSeoTitle(LONG_CARD, CARD_IDENTITY);
    expect(fitted.startsWith("Tessera ")).toBe(true);
    expect(fitted).toContain("Vx-70");
    expect(fitted).toContain("Nova-X");
    expect(fitted).toContain("OC");
    expect(fitted).toContain("12GB");

    const boots = "Kestrel Ridgeline 3 Men's Waterproof Leather Hiking Boots with Vibram Outsole Size 10 Brown";
    const fittedBoots = fitSeoTitle(boots, identity({ brand: "Kestrel", model: "Ridgeline 3", productType: ["Hiking Boots"], variants: ["Size 10", "Brown"] }));
    expect(fittedBoots.length).toBeLessThanOrEqual(SEO_TITLE_TARGET);
    expect(fittedBoots).toMatch(/^Kestrel Ridgeline 3 /);
    expect(fittedBoots).toContain("Hiking Boots");
    expect(fittedBoots).toContain("Size 10");
    expect(fittedBoots).toContain("Brown");
  });

  it("removes lower-value words first: praise, repeats, asides, then descriptive words", () => {
    const praised = "Tessera Ultimate Vx-70 Nova-X Premium Graphics Card Graphics Card (2025 Refresh), Quiet Triple Fan Design";
    const fitted = fitSeoTitle(praised, CARD_IDENTITY);
    // Praise and the repeat go first, then the rightmost aside; the rest fits.
    expect(fitted).toBe("Tessera Vx-70 Nova-X Graphics Card (2025 Refresh)");
    expect(fitSeoTitle(LONG_CARD, CARD_IDENTITY)).not.toMatch(/Triple Fan|Silent Cooling|GDDR7/);
  });

  it("strips the site's name once, whatever separator a generator used", () => {
    expect(fitSeoTitle("Tessera Vx-70 Graphics Card · Manifest", CARD_IDENTITY)).toBe("Tessera Vx-70 Graphics Card");
    expect(fitSeoTitle("Tessera Vx-70 Graphics Card | Manifest · Manifest", CARD_IDENTITY)).toBe("Tessera Vx-70 Graphics Card");
    const long = fitSeoTitle(`${LONG_CARD} - Manifest`, CARD_IDENTITY);
    expect(long).toBe("Tessera Vx-70 Nova-X RGB OC 12GB Graphics Card");
    expect(long).not.toMatch(/manifest/i);
    // The product's own name is never taken for the site's.
    expect(fitSeoTitle("Manifest", identity())).toBe("Manifest");
  });

  it("keeps two similar variants apart", () => {
    const base = "Kestrel Ridgeline 3 Men's Waterproof Leather Hiking Boots Wide Fit Size";
    const ten = fitSeoTitle(`${base} 10 Brown`, identity({ brand: "Kestrel", model: "Ridgeline 3", productType: ["Hiking Boots"], variants: ["10", "Brown"] }));
    const eleven = fitSeoTitle(`${base} 11 Brown`, identity({ brand: "Kestrel", model: "Ridgeline 3", productType: ["Hiking Boots"], variants: ["11", "Brown"] }));
    expect(ten).not.toBe(eleven);
    expect(ten).toContain("Size 10");
    expect(eleven).toContain("Size 11");

    const memory12 = fitSeoTitle(LONG_CARD, CARD_IDENTITY);
    const memory16 = fitSeoTitle(LONG_CARD.replace("12GB", "16GB"), CARD_IDENTITY);
    expect(memory12).not.toBe(memory16);
  });

  it("leaves a name that already fits unchanged", () => {
    for (const name of ["Tessera Vx-70 Graphics Card", "Maison Lune Nuit Eau de Parfum 50 ml", "Oakhollow Walnut Dining Table"]) {
      expect(fitSeoTitle(name, identity({ brand: name.split(" ")[0] }))).toBe(name);
    }
  });

  it("works the same way for unrelated families, with no brand or product named in the code", () => {
    const perfume = fitSeoTitle(
      "Maison Lune Nuit Intense Extrait Eau de Parfum Spray for Women 100 ml",
      identity({ brand: "Maison Lune", productType: ["Fragrance"] }),
    );
    expect(perfume.length).toBeLessThanOrEqual(SEO_TITLE_TARGET);
    expect(perfume).toMatch(/^Maison Lune Nuit /);
    expect(perfume).toContain("Eau de Parfum");
    expect(perfume).toContain("100 ml");
    expect(perfume).not.toContain("for Women");

    const table = fitSeoTitle(
      "Oakhollow Solid Walnut Extendable Dining Table for Six to Eight People with Two Leaves 180 x 90 cm",
      identity({ brand: "Oakhollow", productType: ["Dining Tables"] }),
    );
    expect(table.length).toBeLessThanOrEqual(SEO_TITLE_TARGET);
    expect(table).toMatch(/^Oakhollow /);
    expect(table).toContain("Dining Table");
    expect(table).not.toMatch(/\b(?:for|with)$/);

    const food = fitSeoTitle(
      "Harvest Hill Organic Extra Virgin Olive Oil Cold Pressed Unfiltered Glass Bottle 1 L Pack of 2",
      identity({ brand: "Harvest Hill", productType: ["Pantry", "Olive Oils"] }),
    );
    expect(food.length).toBeLessThanOrEqual(SEO_TITLE_TARGET);
    expect(food).toContain("Olive Oil");
    expect(food).toContain("Pack of 2");

    const source = readFileSync("lib/seo-pulse/title-fit.ts", "utf8");
    for (const name of ["Tessera", "Kestrel", "Maison", "Oakhollow", "PNY", "GeForce", "Soundcore", "Sony"]) expect(source).not.toContain(name);
  });

  it("is what the rules title, a sanitised model title and the quality gate all use", () => {
    const product = graphics({ title: LONG_CARD, details: { modelName: "Vx-70 Nova-X RGB OC Triple Fan" } });
    const rules = generateByRules(product, research);
    expect(rules.seoTitle.recommended.length).toBeLessThanOrEqual(SEO_TITLE_MAX);
    expect(rules.seoTitle.recommended).toMatch(/Graphics Card$/);

    const sanitized = sanitizeGenerated({ ...answer(product), seoTitle: { recommended: `${LONG_CARD} · Manifest`, alternatives: [LONG_CARD], reason: "x" } }, product);
    expect(sanitized.seoTitle.recommended).toBe(fitSeoTitle(LONG_CARD, titleIdentity(product)));
    expect(sanitized.seoTitle.recommended).not.toMatch(/Graphics$/);

    const gated = gate(product, { seoTitle: { recommended: LONG_CARD, alternatives: [], reason: "x" } });
    expect(gated.generated.seoTitle.recommended).toBe(fitSeoTitle(LONG_CARD, titleIdentity(product)));
    expect(gated.withheld).not.toContain("SEO title");
  });
});

// ---------------------------------------------- 2. the opening (12–18)

const TITLE = "Tessera Vx-70 Graphics Card 12GB";

describe("a description that names its product near the start (D-129)", () => {
  it("leaves a safe generated opening as it is", () => {
    const html = `<p>The ${TITLE} has 12GB GDDR7 memory. It uses the Aurora architecture.</p>`;
    const gated = gate(graphics(), describeHtml(html));
    expect(gated.generated.description.suggestedHtml).toBe(html);
    expect(gated.repaired.join(" ")).not.toMatch(/plain opening/);
  });

  it("repairs an opening whose only fault is praise in front of a word", () => {
    const html = `<p>The ${TITLE} is a high-performance graphics card with 12GB GDDR7 memory. It connects over PCIe 5.0.</p>`;
    const text = gate(graphics(), describeHtml(html)).generated.description.suggestedHtml ?? "";
    expect(text).toBe(`<p>The ${TITLE} is a graphics card with 12GB GDDR7 memory. It connects over PCIe 5.0.</p>`);
  });

  it("replaces an opening that cannot be repaired with a plain one built from the name and the facts", () => {
    const html = `<p>Experience the power of the ${TITLE}, built for gamers. It connects over PCIe 5.0 and cools with a triple fan.</p><p>The Aurora architecture runs at 2685 MHz.</p>`;
    const gated = gate(graphics(), describeHtml(html));
    const text = gated.generated.description.suggestedHtml ?? "";
    const opening = openingSentence(contentPlan(graphics()));
    expect(opening).toBe(`${TITLE} has 12GB GDDR7 memory and 6,144 shader cores.`);
    expect(text.startsWith(`<p>${opening} It connects over PCIe 5.0`)).toBe(true);
    expect(text).not.toMatch(/Experience the power/);
    expect(gated.repaired).toContain("description: a plain opening naming the product");
  });

  it("names the product in the first sentence once the opening is replaced", () => {
    const html = "<p>Lightweight and stunning, it turns heads. It uses Bluetooth 5.3 and charges over USB-C in 90 minutes.</p>";
    const product = input({
      title: "Brightwave Pulse 2 Wireless Earbuds",
      brand: "Brightwave",
      knowledge: knowledge([
        { label: "Bluetooth", value: "5.3" },
        { label: "Charging port", value: "USB-C" },
        { label: "Charging time", value: "90 minutes" },
      ]),
    });
    const text = gate(product, describeHtml(html)).generated.description.suggestedHtml ?? "";
    const first = sentences(text.replace(/<[^>]+>/g, " ").trim())[0];
    expect(first).toMatch(/^Brightwave Pulse 2 Wireless Earbuds have /);
    expect(text).toContain("It uses Bluetooth 5.3");
  });

  it("writes an opening with no praise, no warranty and only established facts", () => {
    const plan = contentPlan(graphics());
    const opening = openingSentence(plan);
    expect(sentenceProblem(opening, { factText: "", names: [TITLE], manualWarranty: false })).toBeNull();
    expect(opening).not.toMatch(/warrant/i);
    const figures = (text: string) => text.match(/\d[\d,.]*/g) ?? [];
    const allowed = new Set(figures([TITLE, ...plan.facts.map((row) => row.value)].join(" ")));
    for (const figure of figures(opening)) expect(allowed.has(figure)).toBe(true);
    // Nothing reads well in a sentence: only the name, never a guess.
    const bare = contentPlan(input({ title: "Maison Lune Nuit Eau de Parfum 50 ml", brand: "Maison Lune", knowledge: knowledge([{ label: "Top notes", value: "Bergamot, pink pepper" }, { label: "Size", value: "50 ml" }]) }));
    expect(sentenceFacts(bare, 2)).toEqual([]);
    expect(openingSentence(bare)).toBe("This is the Maison Lune Nuit Eau de Parfum 50 ml.");
  });

  it("does not then repeat the full name through the rest of the description", () => {
    const product = graphics({ details: { modelName: "Vx-70" } });
    const html = `<p>Discover what the ${TITLE} can do for you today. It connects over PCIe 5.0.</p><p>The ${TITLE} uses the Aurora architecture. The ${TITLE} boosts to 2685 MHz.</p>`;
    const text = gate(product, describeHtml(html)).generated.description.suggestedHtml ?? "";
    expect(text.split(TITLE).length - 1).toBe(1);
    expect(text.startsWith(`<p>${TITLE} has `)).toBe(true);
    expect(text).toContain("Tessera Vx-70 uses the Aurora architecture");
  });
});

// -------------------------------------- 3. sentences with nothing to say (19–23)

describe("sentences left with nothing to say (D-129)", () => {
  it("keeps the factual clause and drops the one that only carried praise", () => {
    const html = `<p>The ${TITLE} is built on the Aurora architecture. The card uses 12GB GDDR7 memory and delivers high-performance graphics.</p>`;
    const text = gate(graphics(), describeHtml(html)).generated.description.suggestedHtml ?? "";
    expect(text).toContain("The card uses 12GB GDDR7 memory.");
    expect(text).not.toMatch(/delivers|graphics\./);
  });

  it("drops a sentence that is empty once the praise is out, and one that was empty to begin with", () => {
    const html = `<p>The ${TITLE} has 12GB GDDR7 memory. It delivers exceptional performance. It provides quality for everyday use.</p>`;
    const gated = gate(graphics(), describeHtml(html));
    expect(gated.generated.description.suggestedHtml).toBe(`<p>The ${TITLE} has 12GB GDDR7 memory.</p>`);
    expect(gated.repaired.join(" ")).toMatch(/nothing to say/);
    for (const thin of ["It delivers performance.", "It provides quality.", "It offers functionality.", "It provides an experience.", "It delivers results.", "Designed for performance.", "Built for users.", "Ideal for use."]) {
      expect(thinSentence(thin)).toBe(true);
    }
  });

  it("keeps a factual clause next to hype in another family", () => {
    const product = input({
      title: "Oakhollow Arc Floor Lamp",
      brand: "Oakhollow",
      knowledge: knowledge([{ label: "Cable length", value: "2 m" }, { label: "Bulb", value: "E27" }]),
    });
    const html = "<p>The Oakhollow Arc Floor Lamp takes an E27 bulb. It has a 2 m braided cable, and it offers amazing quality.</p>";
    const text = gate(product, describeHtml(html)).generated.description.suggestedHtml ?? "";
    expect(text).toBe("<p>The Oakhollow Arc Floor Lamp takes an E27 bulb. It has a 2 m braided cable.</p>");
  });

  it("does not take a short, plain, true sentence for a thin one", () => {
    for (const sentence of ["It weighs 250 g.", "It pairs over Bluetooth.", "It is compact.", "The strap is leather.", "It folds flat.", "It is a graphics card for gaming."]) {
      expect(thinSentence(sentence)).toBe(false);
    }
    const html = `<p>The ${TITLE} has 12GB GDDR7 memory. It folds into two slots. It is a graphics card for gaming.</p>`;
    expect(gate(graphics(), describeHtml(html)).generated.description.suggestedHtml).toBe(html);
  });

  it("keeps unusual but factual wording", () => {
    const product = input({
      title: "Maison Lune Nuit Eau de Parfum 50 ml",
      brand: "Maison Lune",
      knowledge: knowledge([{ label: "Concentration", value: "Eau de Parfum" }, { label: "Heart notes", value: "Damask rose" }]),
    });
    const html = "<p>The Maison Lune Nuit Eau de Parfum 50 ml opens on bergamot. Its heart holds damask rose distilled in copper stills. The flacon is refillable.</p>";
    expect(gate(product, describeHtml(html)).generated.description.suggestedHtml).toBe(html);
    expect(thinSentence("Its sole uses a lug pattern cut for mud.")).toBe(false);
  });
});

// ----------------------------------------------- 4. the rules meta (24–34)

describe("the rules meta description reads as one sentence (D-129)", () => {
  const meta = () => generateByRules(graphics(), research).metaDescription.recommended;

  it("is one natural sentence naming the product, not a list of specifications", () => {
    expect(meta()).toBe(`${TITLE} features 12GB GDDR7 memory, 6,144 shader cores and 2685 MHz boost clock.`);
    expect(sentences(meta())).toHaveLength(1);
    expect(meta()).not.toMatch(/;|: | – /);
  });

  it("takes the highest-ranked facts, and fewer when fewer fit", () => {
    expect(meta()).toContain("12GB GDDR7 memory");
    const plan = contentPlan(graphics());
    expect(factMetaSentence(plan, { max: 80 })).toBe(`${TITLE} features 12GB GDDR7 memory.`);
    expect(factMetaSentence(plan, { use: "gaming and 3D work" })).toMatch(/ for gaming and 3D work\.$/);
    // A label naming who makes a part is not something the product has (found live).
    const withMaker = contentPlan(graphics({ knowledge: knowledge([{ label: "Chipset Manufacturer", value: "Aurora Labs" }, ...CARD_FACTS], { family: CARD_FAMILY }) }));
    expect(factMetaSentence(withMaker)).not.toMatch(/manufacturer|Aurora Labs/i);
    // Sizes, weights, counts and raw data keys stay in At a Glance and the specifications.
    const measured = contentPlan(input({ title: "Oakhollow Arc Floor Lamp", brand: "Oakhollow", knowledge: knowledge([{ label: "Item weight", value: "4.2 kg" }, { label: "Height", value: "180 cm" }, { label: "Unit count", value: "1 Count" }, { label: "Capacity", value: "2000 milliamp_hours" }, { label: "Bulb", value: "E27" }]) }));
    expect(factMetaSentence(measured)).toBe("Oakhollow Arc Floor Lamp features E27 bulb.");
    // A plural name takes the plural verb.
    expect(factMetaSentence({ ...plan, exactName: "Brightwave Pulse 2 Wireless Earbuds" })).toMatch(/^Brightwave Pulse 2 Wireless Earbuds feature /);
  });

  it("ends cleanly, within the length policy, with no praise, sales call or warranty", () => {
    const text = meta();
    expect(text).toMatch(/[\p{L}\p{N})]\.$/u);
    expect(text).not.toMatch(/,\s*(?:and)?\.$|\band\.$/);
    expect(text.length).toBeGreaterThanOrEqual(50);
    expect(text.length).toBeLessThanOrEqual(160);
    expect(sentenceProblem(text, { factText: "", names: [TITLE], manualWarranty: false })).toBeNull();
    expect(text).not.toMatch(/\b(?:buy|shop|order|today|explore|discover)\b/i);
    expect(text).not.toMatch(/warrant/i);
  });

  it("is used, in English, when the model's meta description is refused", () => {
    const gated = gate(graphics(), {
      metaDescription: { recommended: "Experience the power of gaming. Die Karte ist für Spiele und kreative Arbeit gebaut und hat drei Lüfter.", reason: "x" },
    });
    expect(gated.withheld).toContain("meta description");
    expect(gated.generated.metaDescription.recommended).toBe(meta());
    expect(gated.generated.metaDescription.recommended).not.toMatch(/Karte|Experience/);
  });

  it("is withheld, not filled, when no fact reads well in a sentence", () => {
    const product = input({ title: "Maison Lune Nuit Eau de Parfum 50 ml", brand: "Maison Lune", knowledge: knowledge([{ label: "Top notes", value: "Bergamot, pink pepper, cardamom and cedar" }, { label: "Size", value: "50 ml" }]) });
    expect(generateByRules(product, research).metaDescription.recommended).toBe("");
  });
});

// ------------------------------------ 5. found in the live English-only acceptance

describe("English-only research, as real search results showed it (D-129)", () => {
  it("ranks a country-first English locale as English, and other languages last", () => {
    // A manufacturer's official page for Great Britain, written /gb-en/.
    expect(urlLanguagePreference("https://www.maker.test/gb-en/gaming-mice/model-v3/AB01-0001")).toBe(1);
    expect(urlLanguagePreference("https://www.maker.test/sg-en/gaming-mice/model-v3")).toBe(1);
    expect(urlLanguagePreference("https://www.maker.test/en-gb/gaming-mice/model-v3")).toBe(1);
    expect(urlLanguagePreference("https://www.maker.test/pl-pl/gaming-mice/model-v3")).toBe(-1);
    expect(urlLanguagePreference("https://www.maker.test/ca-fr/gaming-mice/model-v3")).toBe(-1);
    expect(urlLanguagePreference("https://www.maker.test/pt-br/produto/model-v3")).toBe(-1);
    expect(urlLanguagePreference("https://www.shop.test/produkt/model-v3")).toBe(0);
  });
});

// ------------------------- 6. generic predicates left by praise removal (D-129A)

describe("generic predicates praise removal leaves behind (D-129A)", () => {
  const opening = `<p>The ${TITLE} has 12GB GDDR7 memory.</p>`;
  const gatedText = (paragraph: string) => gate(graphics(), describeHtml(`${opening}<p>${paragraph}</p>`)).generated.description.suggestedHtml ?? "";

  it("does not leave \"delivers performance\" once the praise is out", () => {
    const text = gatedText("It delivers exceptional performance. It connects over PCIe 5.0.");
    expect(text).not.toMatch(/delivers performance|delivers/);
    expect(text).toContain("It connects over PCIe 5.0.");
  });

  it("keeps the factual clause next to it", () => {
    expect(gatedText("The card uses 12GB GDDR7 memory and delivers exceptional performance.")).toContain("<p>The card uses 12GB GDDR7 memory.</p>");
  });

  it("keeps the cooling, not the purpose it was praised for", () => {
    const text = gatedText("It has 6,144 shader cores and a triple-fan cooling system to ensure optimal performance and stability.");
    expect(text).toContain("It has 6,144 shader cores and a triple-fan cooling system.");
    expect(text).not.toMatch(/ensure|performance|stability/);
  });

  it("is not exempted by a figure elsewhere in the clause", () => {
    expect(gatedText("The card uses 12GB GDDR7 memory and delivers exceptional performance for 4K gaming.")).toContain("<p>The card uses 12GB GDDR7 memory.</p>");
    // The live sentence: only an introductory phrase would be left, so it goes.
    const text = gatedText(
      "With a boost clock of 2685 MHz, this graphics card delivers exceptional performance for 4K gaming and demanding applications. It connects over PCIe 5.0.",
    );
    expect(text).not.toMatch(/delivers|4K gaming|With a boost clock/);
    expect(text).toContain("It connects over PCIe 5.0.");
  });

  it("leaves a verb with a real object alone", () => {
    for (const sentence of [
      "The memory delivers 28 Gbps memory speed.",
      "The charger provides 100W output over USB-C.",
      "It supports 4K at 120Hz over HDMI 2.1.",
      "It offers four USB-C ports.",
      "It includes three fans and uses 12GB GDDR7 memory.",
      "The lamp provides a performance of 800 lumens.",
    ]) {
      expect(withoutGenericPredicates(sentence)).toBe(sentence);
    }
    // Through the gate, praise out and the real object kept.
    expect(gatedText("It delivers an impressive 28 Gbps memory speed.")).toContain("It delivers a 28 Gbps memory speed.");
  });

  it("puts nothing in the predicate's place", () => {
    const inputs = [
      "The card uses 12GB GDDR7 memory and delivers exceptional performance for 4K gaming.",
      "It offers four USB-C ports, providing premium quality for everyday use.",
      "It has 6,144 shader cores and a triple-fan cooling system to ensure optimal performance and stability.",
    ];
    for (const paragraph of inputs) {
      const text = gatedText(paragraph);
      expect(text).not.toMatch(/built for|ideal for|designed for|suitable for|supports|is made for/i);
    }
    expect(withoutGenericPredicates("It offers four USB-C ports, providing quality for everyday use.")).toBe("It offers four USB-C ports.");
  });

  it("drops a sentence left meaningless", () => {
    expect(withoutGenericPredicates("It delivers performance.")).toBeNull();
    expect(withoutGenericPredicates("This card delivers performance and quality for gamers.")).toBeNull();
    expect(withoutGenericPredicates("With a boost clock of 2685 MHz, this graphics card delivers performance for 4K gaming.")).toBeNull();
    const gated = gate(graphics(), describeHtml(`${opening}<p>This card delivers exceptional performance and quality for gamers.</p>`));
    expect(gated.generated.description.suggestedHtml).toBe(opening);
  });
});

describe("generic predicates in any generated sentence, praised or not (D-129A)", () => {
  const opening = `<p>The ${TITLE} has 12GB GDDR7 memory.</p>`;
  const gatedText = (paragraph: string, base = graphics()) =>
    gate(base, describeHtml(`${opening}<p>${paragraph}</p>`)).generated.description.suggestedHtml ?? "";

  it("removes one the model wrote without any praise", () => {
    expect(gatedText("The card uses 12GB GDDR7 memory and delivers performance for 4K gaming.")).toContain("<p>The card uses 12GB GDDR7 memory.</p>");
    expect(gatedText("It has a triple-fan cooler that ensures stability.")).toContain("<p>It has a triple-fan cooler.</p>");
    const text = gatedText("It provides quality. It connects over PCIe 5.0.");
    expect(text).not.toMatch(/provides quality/);
    expect(text).toContain("It connects over PCIe 5.0.");
  });

  it("keeps real objects in unpraised sentences, and a sentence with no such predicate byte for byte", () => {
    const kept = "The memory delivers 28 Gbps memory speed. The card provides 100W output to its fans. It offers four USB-C ports. It supports 4K at 120Hz. The lamp provides a performance of 800 lumens.";
    expect(gatedText(kept)).toContain(`<p>${kept}</p>`);
    expect(withoutGenericPredicates("It is compact.")).toBe("It is compact.");
  });

  it("keeps \"ensures stability\" when an established fact says so", () => {
    const braced = graphics({ knowledge: knowledge([...CARD_FACTS, { label: "Support bracket", value: "Anti-sag bracket for stability" }], { family: CARD_FAMILY }) });
    expect(gatedText("The included bracket ensures stability.", braced)).toContain("The included bracket ensures stability.");
    expect(gatedText("The included bracket ensures stability.")).not.toContain("ensures stability");
  });

  it("gives an opening removed this way the plain opening instead", () => {
    const text = gate(graphics(), describeHtml(`<p>The ${TITLE} delivers performance for 4K gaming. It connects over PCIe 5.0.</p>`)).generated.description.suggestedHtml ?? "";
    expect(text.startsWith(`<p>${TITLE} has `)).toBe(true);
    expect(text).not.toMatch(/delivers performance/);
  });
});
