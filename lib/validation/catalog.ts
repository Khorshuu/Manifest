import { z } from "zod";

const slug = z
  .string()
  .trim()
  .min(1, "Enter a slug.")
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers, and single hyphens.",
  );

export const categoryInputSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(120),
    slug,
    parentId: z.string().uuid().nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

export type CategoryInputPayload = z.infer<typeof categoryInputSchema>;

export const PRODUCT_STATUS_VALUES = [
  "draft",
  "scheduled",
  "in_stock",
  "preorder_open",
  "preorder_closed",
  "coming_soon",
  "discontinued",
  "archived",
] as const;

/**
 * A text field that may be cleared.
 *
 * `undefined` and `null` mean different things on a product save: absent
 * leaves the stored value alone, null erases it. That distinction is what
 * lets each section of the admin form send only its own fields instead of
 * echoing the whole record back and hoping nothing was dropped in transit.
 * An empty string is treated as null, because a cleared input sends "".
 */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => value.length === 0 || /^https?:\/\/\S+$/i.test(value),
    "Enter a link starting with http:// or https://.",
  )
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional();

const stringList = (max: number, itemMax: number) =>
  z
    .array(z.string().trim().max(itemMax))
    .max(max)
    .transform((values) => values.filter((value) => value.length > 0))
    .nullable()
    .optional();

export const PRODUCT_IDENTIFIER_TYPE_VALUES = [
  "gtin",
  "upc",
  "ean",
  "isbn",
  "asin",
  "mpn",
  "other",
] as const;

export const warrantySchema = z
  .object({
    hasWarranty: z.boolean(),
    durationMonths: z.number().int().min(0).max(1200).nullable().optional(),
    type: clearableText(80),
    provider: clearableText(120),
    description: clearableText(2000),
    terms: clearableText(4000),
  })
  .strict();

export const complianceSchema = z
  .object({
    certifications: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            number: clearableText(80),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    compliance: clearableText(2000),
    safety: clearableText(2000),
    warnings: clearableText(2000),
    countryOfOrigin: clearableText(80),
    regulatory: clearableText(2000),
  })
  .strict();

/** Every advanced attribute is optional and free text — see ProductDetails. */
export const productDetailsSchema = z
  .object({
    manufacturer: clearableText(120),
    manufacturerPartNumber: clearableText(80),
    modelNumber: clearableText(80),
    modelName: clearableText(120),
    releaseDate: clearableText(40),
    unitCount: clearableText(40),
    unitType: clearableText(40),
    material: clearableText(120),
    color: clearableText(80),
    size: clearableText(80),
    dimensions: clearableText(120),
    itemWeight: clearableText(80),
    packageDimensions: clearableText(120),
    packageWeight: clearableText(80),
    compatibility: clearableText(500),
    specialFeatures: clearableText(500),
    intendedUse: clearableText(300),
    careInstructions: clearableText(500),
  })
  .strict();

/**
 * Everything a product save may carry.
 *
 * Creating requires a title and a category; every other field is optional on
 * both paths, and on an update an absent field is left as it was.
 */
const productFields = {
  title: z.string().trim().min(1, "Enter a title.").max(200),
  slug: slug.optional(),
  categoryId: z.string().uuid("Choose a category."),
  brand: clearableText(120),
  sku: z
    .string()
    .trim()
    .max(64)
    .regex(
      /^[A-Za-z0-9._\-\/]*$/,
      "Use letters, numbers, dots, dashes, slashes and underscores.",
    )
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional(),
  identifierType: z.enum(PRODUCT_IDENTIFIER_TYPE_VALUES).nullable().optional(),
  identifierValue: clearableText(64),
  descriptionHtml: clearableText(20_000),
  bulletFeatures: stringList(20, 300),
  boxContents: stringList(40, 200),
  specTable: z
    .array(
      z.object({
        label: z.string().trim().max(120),
        value: z.string().trim().max(300),
      }),
    )
    .max(50)
    .nullable()
    .optional(),
  /** Measurable facts only, and only ones staff actually recorded (D-043). */
  measurements: z
    .array(
      z.object({
        label: z.string().trim().max(120),
        value: z.string().trim().max(300),
      }),
    )
    .max(30)
    .nullable()
    .optional(),
  warranty: warrantySchema.nullable().optional(),
  compliance: complianceSchema.nullable().optional(),
  details: productDetailsSchema.nullable().optional(),
  /** Checked against the category's definitions server-side, not here. */
  attributeValues: z
    .record(z.string().uuid(), z.union([z.string(), z.array(z.string())]))
    .nullable()
    .optional(),
  videoUrl: httpUrl,
  tags: stringList(30, 40),
  searchKeywords: stringList(40, 60),
  /** Off hides the listing from the site's search only — see D-026. */
  searchable: z.boolean().optional(),
  /** Reorders within a relevance tier, never across one. */
  searchBoost: z.number().int().min(-2).max(2).optional(),
  /** The phrase the listing is written to rank for (SEO Pulse, D-038). */
  seoFocusKeyword: clearableText(80),
  seoMetaTitle: clearableText(200),
  seoMetaDescription: clearableText(400),
  seoNoIndex: z.boolean().optional(),
  canonicalUrl: httpUrl,
  status: z.enum(PRODUCT_STATUS_VALUES).optional(),
  publishAt: z.coerce.date().optional().nullable(),
  unpublishAt: z.coerce.date().optional().nullable(),
};

export const productInputSchema = z
  .object({
    ...productFields,
    /** The SKU hold the Add Product form was given (lib/catalog/sku.ts). */
    skuReservationId: z.string().uuid().nullable().optional(),
  })
  .strict();

/**
 * The update schema: same fields, none of them required.
 *
 * This is what makes a sectioned admin form safe. Each panel sends the fields
 * it owns; anything it does not send keeps the value already stored, so
 * saving the warranty panel cannot wipe the SEO panel.
 */
export const productPatchSchema = z
  .object({
    ...productFields,
    title: productFields.title.optional(),
    categoryId: productFields.categoryId.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.identifierValue == null ||
      value.identifierType != null,
    {
      message: "Choose which kind of identifier that number is.",
      path: ["identifierType"],
    },
  );

export type ProductInputPayload = z.infer<typeof productInputSchema>;
export type ProductPatchPayload = z.infer<typeof productPatchSchema>;

export const CATEGORY_ATTRIBUTE_TYPE_VALUES = [
  "text",
  "number",
  "boolean",
  "select",
  "multiselect",
  "date",
  "measurement",
  "color",
  "url",
] as const;

export const categoryAttributeInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name this specification.").max(80),
    dataType: z.enum(CATEGORY_ATTRIBUTE_TYPE_VALUES).default("text"),
    unit: clearableText(16),
    options: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    isRequired: z.boolean().optional(),
    /** Offered as a filter on listings whose results carry a value for it. */
    isFilterable: z.boolean().optional(),
    /** Its values are words the site's search matches. */
    isSearchable: z.boolean().optional(),
  })
  .strict();

export type CategoryAttributeInputPayload = z.infer<
  typeof categoryAttributeInputSchema
>;

export const attributeInputSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(80),
    inputType: z.enum(["select", "text", "number"]).default("select"),
    values: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  })
  .strict();

export type AttributeInputPayload = z.infer<typeof attributeInputSchema>;
