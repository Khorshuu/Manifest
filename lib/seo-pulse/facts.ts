import {
  KEYWORD_INTENTS,
  type GeneratedRecommendations,
  type KeywordIntent,
  type SeoAnalysis,
  type SeoPulseInput,
  type SerpSnapshot,
} from "./types";
import { keywordKey } from "./text";
import { isIdentityLabel, isIdentityLine } from "@/lib/pkb/identity-labels";
import { labelKey } from "@/lib/pkb/normalize";
import type { GroundedAttribute } from "@/lib/pkb/publish";

/**
 * The parts of an analysis that are facts about the listing rather than
 * writing: what is missing, which identifiers exist, whether structured data
 * can be complete. Computed the same way whichever generator ran, and never
 * handed to an AI model to decide — a model does not get to say a GTIN exists.
 */

const IDENTIFIER_LABELS: Record<string, string> = {
  gtin: "GTIN",
  upc: "UPC",
  ean: "EAN",
  isbn: "ISBN",
  mpn: "MPN",
};

export function identifierStatus(input: SeoPulseInput): SeoAnalysis["identifiers"] {
  const rows: SeoAnalysis["identifiers"] = Object.entries(IDENTIFIER_LABELS).map(
    ([type, label]) => {
      let value: string | null = null;
      if (input.identifierType === type && input.identifierValue) {
        value = input.identifierValue;
      } else if (type === "mpn" && input.details.manufacturerPartNumber) {
        value = input.details.manufacturerPartNumber;
      }
      return { type, label, value, status: value ? "present" : "unavailable" };
    },
  );

  rows.push({
    type: "brand",
    label: "Brand",
    value: input.brand,
    status: input.brand ? "present" : "unavailable",
  });
  rows.push({
    type: "sku",
    label: "SKU",
    value: input.sku,
    status: input.sku ? "present" : "unavailable",
  });
  return rows;
}

export function schemaReadiness(input: SeoPulseInput): SeoAnalysis["schemaReadiness"] {
  const gallery = input.images.filter((image) => image.kind === "gallery");
  const identifier =
    input.identifierValue && input.identifierType && input.identifierType !== "other";

  return [
    { field: "name", status: "ready", note: input.title },
    {
      field: "brand",
      status: input.brand ? "ready" : "missing",
      note: input.brand ?? "No brand recorded.",
    },
    {
      field: "sku",
      status: input.sku ? "ready" : "missing",
      note: input.sku ?? "No SKU recorded.",
    },
    {
      field: "gtin / mpn",
      status: identifier || input.details.manufacturerPartNumber ? "ready" : "missing",
      note: identifier
        ? `${input.identifierType?.toUpperCase()} ${input.identifierValue}`
        : "Unavailable. Add one only if the product really carries it.",
    },
    {
      field: "image",
      status: gallery.length > 0 ? "ready" : "missing",
      note: `${gallery.length} gallery photograph${gallery.length === 1 ? "" : "s"}.`,
    },
    {
      field: "description",
      status: input.descriptionText.length > 0 ? "ready" : "missing",
      note:
        input.descriptionText.length > 0
          ? `${input.descriptionText.length} characters.`
          : "No description.",
    },
    {
      field: "price",
      status: input.variants.length > 0 ? "ready" : "missing",
      note:
        input.variants.length > 0
          ? "From the live variant prices, in BDT."
          : "No live variant carries a price yet.",
    },
    {
      field: "availability",
      status: input.variants.length > 0 ? "ready" : "missing",
      note: input.variants.some((variant) => variant.fulfillmentMode === "preorder")
        ? "PreOrder, from the variants."
        : "InStock or SoldOut, from the variants.",
    },
    {
      field: "aggregateRating",
      status: input.reviews.count > 0 ? "ready" : "not_applicable",
      note:
        input.reviews.count > 0
          ? `${input.reviews.count} approved review${input.reviews.count === 1 ? "" : "s"}.`
          : "No approved reviews — left out. A rating is never invented.",
    },
  ];
}

export function contentGaps(input: SeoPulseInput): SeoAnalysis["contentGaps"] {
  const gaps: SeoAnalysis["contentGaps"] = [];
  const specLabels = input.specifications.map((row) => row.label.toLowerCase());
  const hasSpec = (pattern: RegExp) => specLabels.some((label) => pattern.test(label));
  const add = (key: string, label: string, reason: string) =>
    gaps.push({ key, label, reason });

  if (input.descriptionText.length < 300) {
    add(
      "description",
      "Fuller description",
      `The description is ${input.descriptionText.length} characters. Around 300 or more answers the questions a shopper arrives with.`,
    );
  }
  if (input.bulletFeatures.length < 3) {
    add("bullets", "Key features", "Fewer than three key features are listed.");
  }
  if (!input.details.dimensions && !hasSpec(/dimension|size/)) {
    add("dimensions", "Dimensions", "No dimensions are stated.");
  }
  if (!input.details.itemWeight && !hasSpec(/weight/)) {
    add("weight", "Weight", "No weight is stated — it matters for an imported item.");
  }
  if (!input.details.material && !hasSpec(/material|fabric/)) {
    add("material", "Material", "No material is stated.");
  }
  if (!input.details.compatibility && !hasSpec(/compatib/)) {
    add(
      "compatibility",
      "Compatibility",
      "Nothing says what it works with, if that applies to this product.",
    );
  }
  if (!input.details.intendedUse) {
    add("use_case", "Intended use", "Nothing says who or what it is for.");
  }
  if (input.boxContents.length === 0) {
    add("box", "What's in the box", "The box contents are not listed.");
  }
  if (!input.warranty) {
    add("warranty", "Warranty", "Warranty information is not recorded, even to say there is none.");
  }
  if (!input.countryOfOrigin) {
    add("origin", "Country of origin", "Country of origin is not recorded.");
  }
  const gallery = input.images.filter((image) => image.kind === "gallery");
  if (gallery.length < 3) {
    add("photos", "More photographs", `${gallery.length} gallery photograph${gallery.length === 1 ? "" : "s"}; three or more is usual.`);
  }
  if (!input.images.some((image) => image.kind === "lifestyle")) {
    add("lifestyle", "Photographs in use", "No lifestyle photographs.");
  }
  add(
    "faq",
    "Frequently asked questions",
    "The product page has no question-and-answer content; see the FAQ opportunities.",
  );
  return gaps;
}

export function keywordGroups(
  generated: GeneratedRecommendations,
): Record<KeywordIntent, string[]> {
  const groups = Object.fromEntries(
    KEYWORD_INTENTS.map((intent) => [intent, [] as string[]]),
  ) as Record<KeywordIntent, string[]>;
  const seen = new Set<string>();
  for (const keyword of [
    generated.primaryKeyword,
    ...generated.secondaryKeywords,
    ...generated.longTailKeywords,
  ]) {
    const key = keywordKey(keyword.keyword);
    if (seen.has(key)) continue;
    seen.add(key);
    groups[keyword.intent].push(keyword.keyword);
  }
  return groups;
}

export function imageFilenames(input: SeoPulseInput, slug: string) {
  return input.images.map((image, index) => {
    const extension = /\.(jpe?g|png|webp|gif|avif)(?:$|\?)/i.exec(image.url)?.[1] ?? "jpg";
    const suffix = image.kind === "lifestyle" ? "in-use" : String(index + 1);
    return {
      imageId: image.id,
      filename: `${slug}-${suffix}.${extension.toLowerCase()}`,
    };
  });
}

/**
 * Patterns across the search results that were actually collected. Every
 * observation names the snapshot it came from; with no snapshot there are
 * none, rather than a guess about what competitors do.
 */
export function competitorObservations(
  serp: SerpSnapshot[],
): SeoAnalysis["competitorObservations"] {
  const observations: SeoAnalysis["competitorObservations"] = [];

  for (const snapshot of serp) {
    if (snapshot.results.length === 0) continue;
    const basis = `Derived from ${snapshot.results.length} results for "${snapshot.keyword}" (${snapshot.source}, ${snapshot.researchedAt.slice(0, 10)}).`;

    const lengths = snapshot.results.map((result) => result.title.length);
    const average = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
    observations.push({
      observation: `Ranking titles average ${average} characters.`,
      basis,
    });

    const counts = new Map<string, number>();
    for (const result of snapshot.results) {
      for (const word of new Set(keywordKey(result.title).split(" "))) {
        if (word.length < 3) continue;
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }
    const common = [...counts.entries()]
      .filter(([, count]) => count >= Math.max(2, Math.ceil(snapshot.results.length / 3)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word]) => word);
    if (common.length > 0) {
      observations.push({
        observation: `Words common to ranking titles: ${common.join(", ")}.`,
        basis,
      });
    }

    const domains = [...new Set(snapshot.results.map((result) => result.domain))].slice(0, 6);
    observations.push({
      observation: `Domains ranking: ${domains.join(", ")}.`,
      basis,
    });

    if (snapshot.hasShoppingResults) {
      observations.push({
        observation: "Shopping results appear — product structured data matters for this search.",
        basis,
      });
    }
    if (snapshot.hasFeaturedSnippet) {
      observations.push({
        observation: "A featured snippet appears — a direct answer in the description could compete for it.",
        basis,
      });
    }
  }

  return observations;
}

/**
 * The advanced-block fields that are measurements, and the labels shoppers
 * see for them. Everything else in that block is a specification.
 */
const MEASUREMENT_FIELDS: [string, string][] = [
  ["size", "Size"],
  ["dimensions", "Product dimensions"],
  ["itemWeight", "Item weight"],
  ["packageDimensions", "Package dimensions"],
  ["packageWeight", "Package weight"],
  ["unitCount", "Unit count"],
  ["unitType", "Unit type"],
];

const SPECIFICATION_FIELDS: [string, string][] = [
  ["manufacturer", "Manufacturer"],
  ["modelName", "Model"],
  ["modelNumber", "Model number"],
  ["manufacturerPartNumber", "Part number"],
  ["material", "Material"],
  ["color", "Colour"],
  ["compatibility", "Compatibility"],
  ["specialFeatures", "Special features"],
  ["intendedUse", "Intended use"],
  ["careInstructions", "Care instructions"],
  ["releaseDate", "Released"],
];

/** A word that reads like a measurement, used only to sort rows, never to make one. */
const MEASURED = /(length|width|height|depth|diameter|weight|capacity|volume|size|dimension|litre|liter|\bml\b|\bkg\b|\bcm\b|\bmm\b|\binch\b)/i;

type Row = { label: string; value: string };

function tidy(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const row of rows) {
    const label = row.label.trim();
    const value = row.value.trim();
    const key = label.toLowerCase();
    if (!label || !value || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value });
  }
  return out;
}

/**
 * The specification table SEO Pulse offers (D-043).
 *
 * Every row comes from something staff already recorded — the brand, the
 * category's own specifications, the advanced block, the rows typed by hand.
 * Nothing is derived, estimated or inferred, so a listing that records little
 * gets a short table rather than a plausible-looking invented one.
 */
export function specificationRows(input: SeoPulseInput): Row[] {
  const measurementKeys = new Set(MEASUREMENT_FIELDS.map(([key]) => key));

  return tidy([
    ...(input.brand ? [{ label: "Brand", value: input.brand }] : []),
    // The category's questions and any hand-typed rows, minus anything that
    // is really a measurement — that belongs in the other table.
    ...input.specifications.filter((row) => !MEASURED.test(row.label)),
    ...SPECIFICATION_FIELDS.flatMap(([key, label]) =>
      input.details[key] && !measurementKeys.has(key)
        ? [{ label, value: input.details[key] }]
        : [],
    ),
    ...(input.countryOfOrigin
      ? [{ label: "Country of origin", value: input.countryOfOrigin }]
      : []),
    ...(input.warranty?.hasWarranty && input.warranty.durationMonths
      ? [{ label: "Warranty", value: `${input.warranty.durationMonths} months` }]
      : []),
    ...(input.identifierType && input.identifierValue
      ? [
          {
            label: input.identifierType.toUpperCase(),
            value: input.identifierValue,
          },
        ]
      : []),
    /*
     * Last, so a value staff typed on the listing keeps the row and the
     * knowledge base only adds specifications the listing does not carry
     * (D-113). `tidy` keeps the first row for a label and drops the rest.
     */
    ...knowledgeRows(input, "specification"),
  ]);
}

/**
 * The product-level facts the knowledge base has established, as table rows.
 *
 * Only what `groundedKnowledge` returned, which is only VERIFIED or MANUAL
 * values. Variant-scoped values are left out of a product-level table: they
 * describe one offer, not the product.
 */
function knowledgeRows(input: SeoPulseInput, kind: "specification" | "measurement"): Row[] {
  const wanted = (attribute: GroundedAttribute) =>
    (MEASURED.test(attribute.label) ? "measurement" : "specification") === kind;
  return (input.knowledge?.attributes ?? [])
    // What is in the box has its own list (`boxContents`). As a table row it
    // was one item of several — `tidy` keeps the first row for a label — and
    // it became a key feature: "What's in the box: 1× USB receiver" (D-120).
    .filter((attribute) => attribute.key !== "box_contents")
    .filter((attribute) => attribute.pkbVariantId === null && wanted(attribute))
    .map((attribute) => ({
      label: attribute.label,
      /*
       * The unit is appended only to a value that is a bare number. A value
       * read from a manufacturer's page usually spells its own unit — "665g",
       * "7.97 ounces (226 grams)" — and normalisation stores the unit beside
       * it, so appending it anyway prints "665g g".
       */
      value:
        attribute.unit && !/\p{L}/u.test(attribute.value)
          ? `${attribute.value} ${attribute.unit}`
          : attribute.value,
    }));
}

/**
 * The measurements SEO Pulse offers — only ones that were recorded.
 *
 * A measurement nobody supplied is left out, and the product page hides the
 * whole tab when this is empty. Guessing a weight would be worse than silence:
 * a shopper can act on a wrong figure.
 */
export function measurementRows(input: SeoPulseInput): Row[] {
  return tidy([
    ...input.measurements,
    ...MEASUREMENT_FIELDS.flatMap(([key, label]) =>
      input.details[key] ? [{ label, value: input.details[key] }] : [],
    ),
    // A category specification such as "Capacity: 750 ml" is a measurement
    // wherever it was entered.
    ...input.specifications.filter((row) => MEASURED.test(row.label)),
    ...knowledgeRows(input, "measurement"),
  ]);
}

// ------------------------------------------------ is there enough to write from

/**
 * Whether there is enough established fact to write a product listing (D-115).
 *
 * The rules generator will always produce *something*: with an empty listing
 * it produces "<product> is part of our <category> range and is sourced from
 * the United States", which is true, generic and worth nothing to a shopper.
 * The problem is not the sentence — it is a reasonable fallback — but calling
 * the result a researched product listing when no product fact went into it.
 *
 * So the verdict is stated rather than implied. A run whose grounding is thin
 * is still generated and still available to apply by hand; product preparation
 * reads this and stops instead of reporting a product as READY.
 *
 * What counts is a *fact about the product*: its brand, an identifier, a
 * specification, a measurement, a key feature staff wrote, the box contents, a
 * description of some substance. What does not count: the category, the title,
 * the price, the delivery terms — every listing has those, and a description
 * assembled from them describes nothing.
 */
export type KnowledgeSufficiency = {
  sufficient: boolean;
  /**
   * How many distinct facts *about the product* are established: what it is,
   * not what it is called and not what it costs. Identity, price, stock,
   * delivery and warranty terms never count (D-123).
   */
  facts: number;
  /** The least number of such facts a listing is written from. */
  required: number;
  /** What would most improve it, in the order worth doing. */
  missing: string[];
  /** Whether the product is at least named: a brand, or an identifier. Necessary, never sufficient. */
  identified: boolean;
  /** How the product's family schema was satisfied, when it has one. */
  family: {
    name: string;
    /** Attributes the family requires that are not established. */
    requiredMissing: string[];
    /** Attributes the family recommends that are not established. */
    recommendedMissing: string[];
    /** Recommended attributes still needed before the family's recommendation is met. */
    recommendedShort: number;
  } | null;
  /**
   * Set when there is no useful family schema to judge the product by: the
   * one-time vocabulary work that would let this kind of product be judged
   * (D-123). Guidance, not a requirement anyone invented.
   */
  schemaGap: string | null;
  /** One sentence for a staff member. */
  summary: string;
};

/**
 * The least number of established product facts a listing is written from.
 *
 * Not the old "four facts" rule lowered: that rule counted the brand and an
 * identifier, so two facts about the product and its name were enough. This
 * counts only facts about the product itself, and the product's family adds
 * its own requirements on top (D-123).
 */
export const MIN_PRODUCT_FACTS = 3;

/** Terms of the offer, never facts about the product (I-8). */
const COMMERCIAL_LABEL = /^(price|sale price|regular price|availability|stock|in stock|shipping|delivery|warranty)$/i;

export function knowledgeSufficiency(input: SeoPulseInput): KnowledgeSufficiency {
  const missing: string[] = [];
  const identified =
    Boolean(input.brand) ||
    Boolean(input.identifierValue) ||
    Boolean(input.details.manufacturerPartNumber) ||
    Boolean(input.details.modelNumber) ||
    (input.knowledge?.identifiers.length ?? 0) > 0;

  /*
   * Facts about the product, each counted once by its label. Identity rows
   * are not among them: the specification table restates whatever names the
   * product — brand, model, part number, trade identifier — and counting those
   * would let "Sony / WH-1000XM6" be called researched. The warranty is an
   * assurance term of the offer (D-120), not something the product is.
   */
  const described = new Set<string>();
  for (const row of [...specificationRows(input), ...measurementRows(input)]) {
    if (isIdentityLabel(row.label) || COMMERCIAL_LABEL.test(row.label.trim())) continue;
    described.add(labelKey(row.label));
  }
  let facts = described.size;

  // "Part number: GO-WHITE" written as a key feature is still only a name
  // (D-119), and key features or a description SEO Pulse wrote itself vouch
  // for nothing (D-120).
  const staffFeatures = input.pulseWritten?.bulletFeatures ? [] : input.bulletFeatures;
  const hasFeatures = staffFeatures.some((feature) => !isIdentityLine(feature));
  if (hasFeatures) facts += 1;
  if (input.boxContents.length > 0) facts += 1;
  if (!input.pulseWritten?.description && input.descriptionText.length >= 200) facts += 1;

  /*
   * The family decides what else a product of this kind needs (D-123). A
   * mouse and a hair colour are not asked the same questions: whatever the
   * family requires must be established, and at least half of what it
   * recommends (up to three). An optional attribute is never demanded.
   */
  const knownKeys = new Set(
    (input.knowledge?.attributes ?? []).filter((attribute) => attribute.pkbVariantId === null).map((attribute) => attribute.key),
  );
  const knownLabels = new Set([
    ...(input.knowledge?.attributes ?? []).map((attribute) => labelKey(attribute.label)),
    ...input.specifications.map((row) => labelKey(row.label)),
    ...input.measurements.map((row) => labelKey(row.label)),
  ]);
  const established = (attribute: { key: string; label: string }) =>
    knownKeys.has(attribute.key) || knownLabels.has(labelKey(attribute.label));

  const schema = input.knowledge?.family ?? null;
  let family: KnowledgeSufficiency["family"] = null;
  let schemaGap: string | null = null;
  if (schema) {
    const required = schema.attributes.filter((attribute) => attribute.requirement === "required");
    const recommended = schema.attributes.filter((attribute) => attribute.requirement === "recommended");
    const recommendedMissing = recommended.filter((attribute) => !established(attribute)).map((attribute) => attribute.label);
    const recommendedWanted = Math.min(3, Math.ceil(recommended.length / 2));
    family = {
      name: schema.name,
      requiredMissing: required.filter((attribute) => !established(attribute)).map((attribute) => attribute.label),
      recommendedMissing,
      recommendedShort: Math.max(0, recommendedWanted - (recommended.length - recommendedMissing.length)),
    };
    if (schema.attributes.length === 0) {
      schemaGap = `The ${schema.name} family asks for no attributes yet. Decide the labels research found for this product — add the useful ones to the family — and later products of this kind are understood automatically.`;
    }
  } else {
    schemaGap =
      "This kind of product has no specification schema yet. Decide the labels research found for it — add the useful ones to its family — and later products of this kind are understood automatically.";
  }

  missing.push(...(family?.requiredMissing ?? []));
  if (family && family.recommendedShort > 0) missing.push(...family.recommendedMissing.slice(0, 3));
  if (facts < MIN_PRODUCT_FACTS) {
    missing.push(`Established facts about the product (${facts} of ${MIN_PRODUCT_FACTS})`);
    if (!hasFeatures) missing.push("Key features");
  }
  if (!input.brand) missing.push("Brand");

  const sufficient =
    facts >= MIN_PRODUCT_FACTS && (family?.requiredMissing.length ?? 0) === 0 && (family?.recommendedShort ?? 0) === 0;

  const summary = sufficient
    ? `${facts} facts about the product are established${schema ? ` for the ${schema.name} family` : ""}.`
    : family && family.requiredMissing.length > 0
      ? `The ${family.name} family needs ${family.requiredMissing.join(", ")}, and ${facts} of the ${MIN_PRODUCT_FACTS} facts about the product needed are established.`
      : `${facts} of the ${MIN_PRODUCT_FACTS} facts about the product needed are established${schema ? ` for the ${schema.name} family` : ""}.`;

  return { sufficient, facts, required: MIN_PRODUCT_FACTS, missing, identified, family, schemaGap, summary };
}
