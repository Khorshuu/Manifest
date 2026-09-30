import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pkbProducts, type ProductCompliance, type ProductDetails } from "@/db/schema";
import { resolveFamilySchema } from "@/lib/pkb/families";
import { collapseRepeatedUnits } from "@/lib/pkb/unit-text";
import { formatAttributeValue, getAttributeDefinitionsByIds } from "./category-attributes";

/**
 * A listing's facts as the product page shows them (D-128): the specification
 * table, the measurements, and At a Glance, from one assembly so the three
 * can never disagree.
 */

export type ListingFactRow = { label: string; value: string };

type ListingForFacts = {
  brand: string | null;
  attributeValues: unknown;
  details: unknown;
  specTable: unknown;
  measurements: unknown;
  compliance: unknown;
  identifierType: string | null;
  identifierValue: string | null;
};

/*
 * Two lists, not one. Anything measurable goes to the Measurements tab and
 * the rest to Specification, so neither tab repeats the other (D-043).
 */
const DETAIL_LABELS: [keyof ProductDetails, string][] = [
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

const MEASUREMENT_LABELS: [keyof ProductDetails, string][] = [
  ["size", "Size"],
  ["dimensions", "Product dimensions"],
  ["itemWeight", "Item weight"],
  ["packageDimensions", "Package dimensions"],
  ["packageWeight", "Package weight"],
  ["unitCount", "Unit count"],
  ["unitType", "Unit type"],
];

function rows(value: unknown): ListingFactRow[] {
  return Array.isArray(value)
    ? (value as ListingFactRow[]).filter((row) => row?.label?.trim() && row?.value?.trim())
    : [];
}

/** A value stored before D-128 may carry its unit twice ("2685 MHz MHz"); it is shown once. */
function tidy(list: ListingFactRow[]): ListingFactRow[] {
  return list.map((row) => ({ label: row.label, value: collapseRepeatedUnits(String(row.value)) }));
}

/**
 * The specification table, assembled from four sources in the order a shopper
 * reads them: the facts every listing has, then what the category asks of its
 * products, then the advanced block, then anything typed by hand; and the
 * measurements, only as recorded. Every row has a value — a blank is dropped
 * rather than shown as a dash.
 */
export async function listingFactRows(product: ListingForFacts): Promise<{ specifications: ListingFactRow[]; measurements: ListingFactRow[] }> {
  const storedAttributes = (product.attributeValues as Record<string, string | string[]> | null) ?? {};
  const definitions = await getAttributeDefinitionsByIds(Object.keys(storedAttributes));
  const details = (product.details as ProductDetails | null) ?? null;
  const compliance = (product.compliance as ProductCompliance | null) ?? null;

  const specifications: ListingFactRow[] = [
    ...(product.brand ? [{ label: "Brand", value: product.brand }] : []),
    ...definitions
      .map((definition) => {
        const value = storedAttributes[definition.id];
        return value === undefined ? null : { label: definition.name, value: formatAttributeValue(definition, value) };
      })
      .filter((row): row is ListingFactRow => row !== null),
    ...(details
      ? DETAIL_LABELS.map(([key, label]) => (details[key] ? { label, value: String(details[key]) } : null)).filter(
          (row): row is ListingFactRow => row !== null,
        )
      : []),
    ...rows(product.specTable),
    ...(compliance?.countryOfOrigin ? [{ label: "Country of origin", value: compliance.countryOfOrigin }] : []),
    ...(product.identifierValue && product.identifierType
      ? [{ label: product.identifierType.toUpperCase(), value: product.identifierValue }]
      : []),
  ];

  const measurements: ListingFactRow[] = [
    ...rows(product.measurements),
    ...(details
      ? MEASUREMENT_LABELS.map(([key, label]) => (details[key] ? { label, value: String(details[key]) } : null)).filter(
          (row): row is ListingFactRow => row !== null,
        )
      : []),
  ];

  return { specifications: tidy(specifications), measurements: tidy(measurements) };
}

/**
 * What the product's family says matters most, as labels, for At a Glance:
 * required attributes, then SEO-relevant or filterable ones, each in the
 * family's own order. Empty without a family, and At a Glance then prefers
 * short, specific values (lib/seo-pulse/content-plan.ts).
 */
export async function familyGlancePriority(pkbProductId: string | null): Promise<string[]> {
  if (!pkbProductId) return [];
  const [product] = await db.select({ familyId: pkbProducts.familyId }).from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
  if (!product?.familyId) return [];
  const schema = await resolveFamilySchema(db, product.familyId);
  const weight = (attribute: (typeof schema)[number]) =>
    attribute.requirement === "required" ? 0 : attribute.seoRelevant || attribute.filterable ? 1 : attribute.requirement === "recommended" ? 2 : 3;
  return schema
    .filter((attribute) => attribute.definition.status === "approved")
    .map((attribute, index) => ({ label: attribute.definition.label, weight: weight(attribute), index }))
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .map((entry) => entry.label);
}
