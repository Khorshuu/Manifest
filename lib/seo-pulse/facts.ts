import {
  KEYWORD_INTENTS,
  type GeneratedRecommendations,
  type KeywordIntent,
  type SeoAnalysis,
  type SeoPulseInput,
  type SerpSnapshot,
} from "./types";
import { keywordKey } from "./text";

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
