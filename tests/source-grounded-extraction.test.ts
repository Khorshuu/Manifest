/**
 * D-123 — reading what a manufacturer's page says when it says it in prose,
 * without letting a model become the source of a fact. Pure functions only;
 * the stored side is in `source-grounded-pipeline.test.ts`.
 *
 * The Revlon fixture is the real page, trimmed; the Northfield fixture is a
 * fictional skincare page, so nothing here passes because of hair colour.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { identityVerdict, resolveVariant } from "@/lib/pkb/enrichment";
import { extractHtml } from "@/lib/pkb/extract";
import {
  extractionUsefulness,
  groundCandidate,
  groundCandidates,
  locateExcerpt,
  mergeGroundedPairs,
  USEFUL_PAIRS,
} from "@/lib/pkb/grounding";
import { isStrongModelKey, variantDescriptor } from "@/lib/pkb/identity-labels";
import { EMPTY_GROUNDED, type GroundedFamily } from "@/lib/pkb/publish";
import { identifiedByName, type ProductIdentity } from "@/lib/pkb/resolution";
import { seoPulseContentState } from "@/lib/preparation/presentation";
import type { ExtractionCandidate } from "@/lib/providers/extraction/types";
import { readCandidates } from "@/lib/providers/extraction/anthropic";
import { buildQuery } from "@/lib/providers/research/brave";
import { knowledgeSufficiency, MIN_PRODUCT_FACTS } from "@/lib/seo-pulse/facts";
import { generateByRules } from "@/lib/seo-pulse/rules";
import type { SeoPulseInput } from "@/lib/seo-pulse/types";

const REVLON_URL = "https://www.revlon.com/products/colorsilk-beautiful-color-permanent-hair-dye?variant=44106192224451";
const REVLON_HTML = readFileSync("tests/fixtures/revlon-colorsilk.html", "utf8");
const NORTHFIELD_HTML = readFileSync("tests/fixtures/northfield-barrier-cream.html", "utf8");

const revlon = extractHtml(REVLON_HTML, { url: REVLON_URL });
const northfield = extractHtml(NORTHFIELD_HTML, { url: "https://northfield.example/products/daily-barrier-cream" });

const pairsByLabel = (extraction: ReturnType<typeof extractHtml>) =>
  Object.fromEntries(extraction.pairs.map((pair) => [pair.label, pair]));

function identity(overrides: Partial<ProductIdentity> = {}): ProductIdentity {
  return {
    pkbProductId: "00000000-0000-4000-8000-000000000001",
    name: "Revlon Colorsilk Hair Color - Black",
    brands: [{ id: "b", name: "Revlon", key: "revlon" }],
    modelName: "Shade 10",
    generation: null,
    modelKeys: [],
    gtins: [],
    weakModelKeys: ["(1N)", "10"],
    variantValues: ["Shade 10"],
    ...overrides,
  };
}

const candidate = (overrides: Partial<ExtractionCandidate>): ExtractionCandidate => ({
  label: "Gray coverage",
  value: "100%",
  unit: null,
  excerpt: "Ammonia-free** color delivers 100% gray coverage",
  section: "DETAILS",
  meaning: "grey coverage",
  kind: "product_fact",
  ...overrides,
});

// ------------------------------------------------------------ extraction

describe("the deterministic readers, on their own", () => {
  it("read the real Revlon page's sections, its selected shade and its product family", () => {
    const pairs = pairsByLabel(revlon);
    expect(pairs.Color.value).toBe("Black (010)");
    expect(pairs.Color.scope).toBe("variant");
    expect(pairs.DETAILS.value).toContain("up to 98% less breakage");
    expect(pairs["HOW TO USE IT"].value).toContain("Step 1: Mix.");
    // A numbered step is part of the procedure, not an attribute called "Step 3".
    expect(Object.keys(pairs).some((label) => /^step \d/i.test(label))).toBe(false);
    // Reviews and navigation are furniture.
    expect(revlon.pairs.some((pair) => /5\/5|Nathan/.test(`${pair.label} ${pair.value}`))).toBe(false);
    expect(revlon.identity.variants).toHaveLength(5);
    expect(revlon.identity.variants?.[revlon.identity.displayedVariant!].distinguishing).toEqual(["Black"]);
  });

  it("read a non-electronics page the same way, with nothing about hair colour", () => {
    const pairs = pairsByLabel(northfield);
    expect(pairs["Skin type"].value).toBe("Dry, sensitive");
    expect(pairs["Net contents"].value).toBe("50 ml");
    expect(pairs.Ingredients.value).toContain("Ceramide NP");
    expect(pairs["How to use"].value).toContain("pea-sized");
    expect(pairs.Warnings.value).toContain("external use only");
    expect(northfield.pairs.some((pair) => /Priya|4\.5 out of 5/.test(`${pair.label} ${pair.value}`))).toBe(false);
  });

  it("measure a specification page as useful and a prose page as needing a second reading", () => {
    const table = extractHtml(
      `<table>${Array.from({ length: 8 }, (_, index) => `<tr><td>Spec ${index}</td><td>${index + 1} mm</td></tr>`).join("")}</table><p>${"Plain text. ".repeat(40)}</p>`,
    );
    expect(extractionUsefulness(table).useful).toBeGreaterThanOrEqual(USEFUL_PAIRS);
    expect(extractionUsefulness(table).needsAssistance).toBe(false);
    expect(extractionUsefulness(revlon).needsAssistance).toBe(true);
  });
});

// --------------------------------------------------------------- grounding

describe("an intelligent reading is checked against the page", () => {
  const context = { text: revlon.text, versions: { ours: ["Black"] } };

  it("keeps a fact the page states in prose, with the page's own words as the evidence", () => {
    const result = groundCandidate(
      // The model's copy differs in case, quotes and the footnote marks; the page's wording is stored.
      candidate({ excerpt: "ammonia-free color delivers 100% gray coverage" }),
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grounded.pair.method).toBe("ai_assisted");
    expect(result.grounded.pair.excerpt).toBe("Ammonia-free** color delivers 100% gray coverage");
    expect(revlon.text).toContain(result.grounded.pair.excerpt);
    expect(result.grounded.pair.value).toBe("100%");
  });

  it("finds facts across the page's prose sections", () => {
    const report = groundCandidates(
      [
        candidate({ label: "Processing time", value: "25 minutes", excerpt: "Leave it on for 25 minutes total.", kind: "compatibility_use" }),
        candidate({ label: "Color duration", value: "up to 8 weeks", excerpt: "up to 8 weeks of vibrant, salon-quality color and shine" }),
        candidate({ label: "What's in the box", value: "cream developer bottle", excerpt: "pour the ammonia-free colorant into the cream developer bottle", kind: "box_content" }),
        candidate({ label: "Hair types", value: "all hair types and textures", excerpt: "Works on all hair types and textures." }),
      ],
      context,
    );
    expect(report.rejected).toEqual([]);
    expect(report.grounded.map((entry) => entry.pair.label)).toEqual(["Processing time", "Color duration", "What's in the box", "Hair types"]);
  });

  it("rejects a candidate whose excerpt is not on the page", () => {
    const result = groundCandidate(candidate({ excerpt: "Dermatologist tested and approved for sensitive scalps" , value: "Dermatologist tested", label: "Testing" }), context);
    expect(result).toEqual({ ok: false, reason: "excerpt_not_in_source" });
  });

  it("rejects a number the excerpt does not contain", () => {
    expect(groundCandidate(candidate({ label: "Color duration", value: "up to 12 weeks", excerpt: "up to 8 weeks of vibrant, salon-quality color and shine" }), context)).toEqual({
      ok: false,
      reason: "unsupported_number",
    });
    expect(groundCandidate(candidate({ value: "98%", excerpt: "Ammonia-free** color delivers 100% gray coverage" }), context)).toEqual({
      ok: false,
      reason: "unsupported_number",
    });
  });

  it("rejects an ingredient, a certification or a claim the excerpt does not state", () => {
    expect(groundCandidate(candidate({ label: "Formulation", value: "ammonia-free and paraben-free", excerpt: "Ammonia-free** color delivers 100% gray coverage" }), context)).toEqual({
      ok: false,
      reason: "unsupported_value",
    });
    expect(groundCandidate(candidate({ label: "Cruelty free", value: "Yes", excerpt: "Works on all hair types and textures." }), context)).toEqual({
      ok: false,
      reason: "unsupported_label",
    });
  });

  it("never takes identity, marketing or the offer from a model", () => {
    expect(groundCandidate(candidate({ label: "Model number", value: "010", excerpt: "Black (010)", kind: "identity" }), context).ok).toBe(false);
    expect(groundCandidate(candidate({ label: "Claim", value: "#1 hair color in the U.S.", excerpt: "Expect everything from the #1 hair color in the U.S.", kind: "marketing" }), context).ok).toBe(false);
    expect(groundCandidate(candidate({ label: "Price", value: "$6.79", excerpt: "$6.79" }), { text: `${revlon.text} $6.79`, versions: null }).ok).toBe(false);
  });

  it("keeps a version's fact only when it names this product's version", () => {
    const text = `${revlon.text}\nLight Ash Blonde (08) lifts up to 3 levels.`;
    expect(groundCandidate(candidate({ label: "Shade", value: "Black (010)", excerpt: "Black (010)", kind: "variant_fact" }), { text, versions: { ours: ["Black"] } }).ok).toBe(true);
    expect(
      groundCandidate(candidate({ label: "Lift", value: "up to 3 levels", excerpt: "Light Ash Blonde (08) lifts up to 3 levels.", kind: "variant_fact" }), { text, versions: { ours: ["Black"] } }),
    ).toEqual({ ok: false, reason: "other_variant" });
    expect(groundCandidate(candidate({ label: "Shade", value: "Black (010)", excerpt: "Black (010)", kind: "variant_fact" }), { text, versions: { ours: null } })).toEqual({
      ok: false,
      reason: "variant_unresolved",
    });
  });

  it("adds grounded facts after the deterministic ones without repeating them", () => {
    const report = groundCandidates([candidate({})], context);
    const merged = mergeGroundedPairs(revlon.pairs, report.grounded);
    expect(merged.slice(0, revlon.pairs.length)).toEqual(revlon.pairs);
    expect(merged).toHaveLength(revlon.pairs.length + 1);
    expect(mergeGroundedPairs(merged, report.grounded)).toHaveLength(merged.length);
  });

  it("locates an excerpt quoted with an ellipsis only when every piece is on the page", () => {
    expect(locateExcerpt(revlon.text, "Step 3: Leave in. Apply any remaining product … Leave it on for 25 minutes total.")).toContain("massage your strands");
    expect(locateExcerpt(revlon.text, "Step 3: Leave in. Apply any remaining product … Leave it on for 45 minutes total.")).toBeNull();
  });

  it("drops a malformed answer rather than repairing it", () => {
    const read = readCandidates(
      { candidates: [{ label: "Ok", value: "1", excerpt: "x", kind: "product_fact" }, { label: "", value: "2", excerpt: "y", kind: "product_fact" }, { label: "Bad", value: "3", excerpt: "z", kind: "guess" }] },
      10,
    );
    expect(read.map((entry) => entry.label)).toEqual(["Ok"]);
  });
});

// ---------------------------------------------------------------- identity

describe("which recorded codes identify a product", () => {
  it("does not treat a shade, a shade number or a tone code as model identity", () => {
    expect(isStrongModelKey("Shade 10")).toBe(false);
    expect(isStrongModelKey("10")).toBe(false);
    expect(isStrongModelKey("(1N)")).toBe(false);
    expect(isStrongModelKey("010")).toBe(false);
    expect(variantDescriptor("Shade 10")).toEqual({ dimension: "shade", value: "10" });
    expect(variantDescriptor("Colour: Black")).toEqual({ dimension: "colour", value: "Black" });
  });

  it("keeps a real manufacturer code as model identity", () => {
    for (const code of ["GLO-OC-WL-BLK", "GO-WHITE", "WH-1000XM5", "G502", "HP-900", "MX3"]) expect(isStrongModelKey(code)).toBe(true);
    expect(variantDescriptor("GLO-OC-WL-BLK")).toBeNull();
  });

  it("accepts brand, exact name and version as an identity, and refuses a vague name", () => {
    expect(identifiedByName(identity())).toBe(true);
    expect(identifiedByName(identity({ name: "Revlon Hair Color", variantValues: [] }))).toBe(false);
    expect(identifiedByName(identity({ brands: [] }))).toBe(false);
  });
});

describe("whether the Revlon page is about the Revlon listing", () => {
  it("matches the listing's shade on a page selling several, and uses what it says about that shade", () => {
    const verdict = identityVerdict(identity(), revlon);
    expect(verdict.match).toBe("match");
    expect(verdict.variantPairsUsable).toBe(true);
    expect((verdict.notes.variants as { ours: string }).ours).toContain("- Black");
  });

  it("ignores short codes typed into the model fields instead of calling the page a different product", () => {
    // An identity loaded before D-123 kept "10" and "(1N)" as model keys.
    expect(identityVerdict(identity({ modelKeys: ["(1N)", "10"] }), revlon).match).toBe("match");
  });

  it("does not use the page's selected shade for a listing of another shade", () => {
    const verdict = identityVerdict(identity({ name: "Revlon Colorsilk Hair Color - Soft Black", variantValues: [] }), revlon);
    expect(verdict.match).toBe("match");
    expect(verdict.variantPairsUsable).toBe(false);
    expect(resolveVariant(identity({ name: "Revlon Colorsilk Hair Color - Soft Black" }), revlon.identity.variants!).index).toBe(3);
  });

  it("uses nothing for a shade the page does not sell, another product line, or another brand", () => {
    expect(identityVerdict(identity({ name: "Revlon Colorsilk Hair Color - Burgundy" }), revlon).match).toBe("unknown");
    expect(identityVerdict(identity({ name: "Revlon Super Lustrous Lipstick - Black Cherry" }), revlon).match).toBe("unknown");
    expect(identityVerdict(identity({ brands: [{ id: "x", name: "Garnier", key: "garnier" }] }), revlon).match).toBe("mismatch");
  });

  it("matches on a barcode the page only states as a SKU, and still refuses a different barcode", () => {
    expect(identityVerdict(identity({ gtins: [{ gtin14: "00309970185015", pkbVariantId: null }] }), revlon).match).toBe("match");
    const other = extractHtml(REVLON_HTML.replace('"sku":"0309970185015","brand"', '"gtin13":"4006381333931","sku":"0309970185015","brand"'), { url: REVLON_URL });
    expect(identityVerdict(identity({ gtins: [{ gtin14: "05012345678900", pkbVariantId: null }] }), other).match).toBe("mismatch");
  });

  it("stops rather than mixing shades when the version cannot be told", () => {
    const shades = extractHtml(REVLON_HTML.replace(/ - Soft Black/g, " - Black Soft"), { url: REVLON_URL });
    // "Black" and "Black Soft" are both in a listing named "… Black Soft Black"; neither is more specific.
    const verdict = identityVerdict(identity({ name: "Revlon Colorsilk Hair Color - Black Soft", variantValues: ["Soft Black"] }), shades);
    expect(["unknown", "match"]).toContain(verdict.match);
    if (verdict.match === "match") expect(verdict.variantPairsUsable).toBe(false);
  });
});

// ---------------------------------------------------------------- discovery

describe("the automatic discovery query", () => {
  const query = { name: "", brand: null, modelNumbers: [], gtins: [], preferredDomains: [], limit: 5 };

  it("searches the brand and exact product name with its version when there is no GTIN or model number", () => {
    expect(buildQuery({ ...query, name: "Revlon Colorsilk Hair Color - Black", brand: "Revlon", modelNumbers: ["10", "(1N)"], variantValues: ["Shade 10"] })).toBe(
      "Revlon Colorsilk Hair Color Black Shade 10",
    );
    expect(buildQuery({ ...query, name: "Daily Barrier Cream 50 ml", brand: "Northfield Botanics" })).toBe("Northfield Botanics Daily Barrier Cream 50 ml");
  });

  it("still prefers a GTIN, then a real model number", () => {
    expect(buildQuery({ ...query, name: "x", brand: "Glorious", gtins: ["00840408304115"], modelNumbers: ["GLO-OC-WL-BLK"] })).toBe("Glorious 00840408304115");
    expect(buildQuery({ ...query, name: "x", brand: "Glorious", modelNumbers: ["GLO-OC-WL-BLK"] })).toBe("Glorious GLO-OC-WL-BLK");
  });

  it("does not search a vague identity", () => {
    expect(buildQuery({ ...query, name: "Revlon Hair Color", brand: "Revlon", modelNumbers: ["10"] })).toBeNull();
    expect(buildQuery({ ...query, name: "Colorsilk Hair Color Black", brand: null })).toBeNull();
    expect(buildQuery({ ...query, name: "Hair Color", brand: "Revlon", variantValues: [] })).toBeNull();
  });
});

// -------------------------------------------------------------- sufficiency

function pulseInput(overrides: Partial<SeoPulseInput> = {}): SeoPulseInput {
  return {
    productId: "p",
    knowledge: EMPTY_GROUNDED,
    title: "Revlon Colorsilk Hair Color - Black",
    slug: "revlon-colorsilk-hair-color-black",
    brand: "Revlon",
    sku: null,
    identifierType: null,
    identifierValue: null,
    categoryId: "c",
    categoryPath: ["Beauty & Care"],
    status: "draft",
    descriptionText: "",
    bulletFeatures: [],
    specifications: [],
    measurements: [],
    details: { modelName: "Shade 10", modelNumber: "(1N)", manufacturerPartNumber: "10" },
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

const established = (rows: { key: string; label: string; value: string }[], family: GroundedFamily | null = null) => ({
  ...EMPTY_GROUNDED,
  family,
  attributes: rows.map((row) => ({ ...row, unit: null, pkbVariantId: null, state: "VERIFIED" })),
});

const MOUSE: GroundedFamily = {
  id: "f1",
  name: "Mice",
  attributes: [
    { key: "sensor", label: "Sensor", requirement: "required" },
    { key: "max_dpi", label: "Max DPI", requirement: "required" },
    { key: "weight", label: "Weight", requirement: "optional" },
  ],
};

const HAIR_COLOUR: GroundedFamily = {
  id: "f2",
  name: "Hair colour",
  attributes: [
    { key: "shade", label: "Shade", requirement: "required" },
    { key: "formulation", label: "Formulation", requirement: "recommended" },
    { key: "processing_time", label: "Processing time", requirement: "recommended" },
  ],
};

describe("whether enough is known, for this kind of product", () => {
  it("never calls a product described by its identity alone", () => {
    const verdict = knowledgeSufficiency(pulseInput());
    expect(verdict.sufficient).toBe(false);
    expect(verdict.identified).toBe(true);
    expect(verdict.facts).toBe(0);
  });

  it("judges a technical product by its family's requirements", () => {
    const partial = knowledgeSufficiency(
      pulseInput({
        title: "Glorious Model O",
        knowledge: established(
          [
            { key: "sensor", label: "Sensor", value: "BAMF 2.0" },
            { key: "connectivity", label: "Connectivity", value: "2.4 GHz wireless" },
            { key: "switch_type", label: "Switch Type", value: "Glorious Switches" },
          ],
          MOUSE,
        ),
      }),
    );
    expect(partial.facts).toBe(3);
    expect(partial.sufficient).toBe(false);
    expect(partial.family?.requiredMissing).toEqual(["Max DPI"]);
    expect(partial.missing[0]).toBe("Max DPI");

    const complete = knowledgeSufficiency(
      pulseInput({
        knowledge: established(
          [
            { key: "sensor", label: "Sensor", value: "BAMF 2.0" },
            { key: "max_dpi", label: "Max DPI", value: "19,000" },
            { key: "connectivity", label: "Connectivity", value: "2.4 GHz wireless" },
          ],
          MOUSE,
        ),
      }),
    );
    expect(complete.sufficient).toBe(true);
  });

  it("judges a hair colour by what a hair colour needs, never by measurements", () => {
    const verdict = knowledgeSufficiency(
      pulseInput({
        knowledge: established(
          [
            { key: "shade", label: "Shade", value: "Black (010)" },
            { key: "formulation", label: "Formulation", value: "Ammonia-free" },
            { key: "gray_coverage", label: "Gray coverage", value: "100%" },
          ],
          HAIR_COLOUR,
        ),
      }),
    );
    expect(verdict.sufficient).toBe(true);
    expect(verdict.missing.join(" ")).not.toMatch(/measurement|dimension|weight/i);

    const short = knowledgeSufficiency(pulseInput({ knowledge: established([{ key: "shade", label: "Shade", value: "Black (010)" }], HAIR_COLOUR) }));
    expect(short.sufficient).toBe(false);
    expect(short.missing).toContain("Formulation");
    expect(short.missing.join(" ")).not.toMatch(/measurement/i);
  });

  it("says a missing schema is a schema gap, not a missing measurement", () => {
    const none = knowledgeSufficiency(pulseInput({ knowledge: established([{ key: "color", label: "Colour", value: "Black (010)" }]) }));
    expect(none.schemaGap).toMatch(/no specification schema/i);
    expect(none.missing.join(" ")).not.toMatch(/measurement/i);
    const empty = knowledgeSufficiency(pulseInput({ knowledge: established([], { id: "f", name: "Beauty & Care", attributes: [] }) }));
    expect(empty.schemaGap).toContain("Beauty & Care family asks for no attributes yet");
  });

  it("does not count price, stock, delivery or warranty as knowledge", () => {
    const verdict = knowledgeSufficiency(
      pulseInput({
        specifications: [
          { label: "Price", value: "$6.79" },
          { label: "Availability", value: "In stock" },
          { label: "Shipping", value: "Free" },
        ],
        warranty: { hasWarranty: true, durationMonths: 12 },
      }),
    );
    expect(verdict.facts).toBe(0);
  });

  it("needs at least the stated number of product facts even with no family", () => {
    expect(MIN_PRODUCT_FACTS).toBe(3);
    const three = knowledgeSufficiency(
      pulseInput({
        knowledge: established([
          { key: "color", label: "Colour", value: "Black (010)" },
          { key: "special_features", label: "Special features", value: "Ammonia-free" },
          { key: "how_to_use", label: "How to use", value: "Mix and apply" },
        ]),
      }),
    );
    expect(three.sufficient).toBe(true);
  });
});

// ------------------------------------------------------------- the wording

const research = { siteSearch: null, keywordMetrics: [], serp: [] };

describe("SEO wording from what is known, and nothing when too little is", () => {
  it("writes no generic title or snippet about the shop when research is incomplete", () => {
    const generated = generateByRules(pulseInput(), research);
    expect(generated.seoTitle.recommended).not.toMatch(/price in bangladesh/i);
    expect(generated.metaDescription.recommended).toBe("");
    expect(JSON.stringify(generated)).not.toMatch(/landed price|Order now|sourced from the US/);
    expect(generated.description.suggestedHtml).toBeNull();
    // Search phrases stay: that is how people search, not what the page claims.
    expect(generated.longTailKeywords.some((keyword) => keyword.keyword.includes("price in bangladesh"))).toBe(true);
  });

  it("writes the snippet and key features from the product's own established statements", () => {
    const generated = generateByRules(
      pulseInput({
        knowledge: established([
          { key: "color", label: "Colour", value: "Black (010)" },
          {
            key: "special_features",
            label: "Special features",
            value:
              "New + improved with bond Repair Complex + Vegan Keratin Fillers to help repair hair from the inside out.; Ammonia-free** color delivers 100% gray coverage and up to 8 weeks of vibrant, salon-quality color and shine.",
          },
          { key: "how_to_use", label: "How to use it", value: "Everything you need is inside the box!; Step 1: Mix." },
        ]),
      }),
      research,
    );
    expect(generated.keyFeatures).toContain("Colour: Black (010)");
    expect(generated.keyFeatures).toContain("New + improved with bond Repair Complex + Vegan Keratin Fillers to help repair hair from the inside out.");
    // Instructions are specifications, not features.
    expect(generated.keyFeatures.some((line) => /step 1|inside the box/i.test(line))).toBe(false);
    expect(generated.metaDescription.recommended).toContain("Black (010)");
    expect(generated.metaDescription.recommended).not.toMatch(/landed price|Bangladesh/);
    // Whole statements only, ending where a statement ends.
    expect(generated.metaDescription.recommended).toMatch(/inside out\.$/);
    expect(generated.description.suggestedHtml).toContain("100% gray coverage");
    expect(generated.description.suggestedHtml).not.toContain("comes with finished");
  });
});

// ---------------------------------------------------- previous SeoPulse wording

describe("the editor's account of SeoPulse's own wording", () => {
  const fields = [
    { label: "SEO title", owner: "seo_pulse" as const },
    { label: "meta description", owner: "staff" as const },
  ];

  it("marks SeoPulse's wording as previous content while research is incomplete, and never a person's", () => {
    const state = seoPulseContentState({ fields, sufficient: false, latestStage: "NEEDS_REVIEW" });
    expect(state.stale).toEqual(["SEO title"]);
    expect(state.reason).toBe("insufficient");
    expect(state.pending).toBe(true);
  });

  it("marks it when the latest preparation stopped, even with enough known", () => {
    expect(seoPulseContentState({ fields, sufficient: true, latestStage: "FAILED" })).toEqual({
      stale: ["SEO title"],
      reason: "latest_incomplete",
      pending: false,
    });
  });

  it("presents it as current once research is complete and the run finished", () => {
    expect(seoPulseContentState({ fields, sufficient: true, latestStage: "READY" }).stale).toEqual([]);
  });
});
