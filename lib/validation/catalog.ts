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

export const productInputSchema = z
  .object({
    title: z.string().trim().min(1, "Enter a title.").max(200),
    slug: slug.optional(),
    categoryId: z.string().uuid("Choose a category."),
    brand: z.string().trim().max(120).optional(),
    descriptionHtml: z.string().max(20_000).optional(),
    bulletFeatures: z.array(z.string().trim().max(300)).max(20).optional(),
    specTable: z
      .array(
        z.object({
          label: z.string().trim().max(120),
          value: z.string().trim().max(300),
        }),
      )
      .max(50)
      .optional(),
    tags: z.array(z.string().trim().max(40)).max(30).optional(),
    seoMetaTitle: z.string().trim().max(200).optional(),
    seoMetaDescription: z.string().trim().max(400).optional(),
    status: z.enum(PRODUCT_STATUS_VALUES).optional(),
    publishAt: z.coerce.date().optional().nullable(),
  })
  .strict();

export type ProductInputPayload = z.infer<typeof productInputSchema>;

export const attributeInputSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(80),
    inputType: z.enum(["select", "text", "number"]).default("select"),
    values: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  })
  .strict();

export type AttributeInputPayload = z.infer<typeof attributeInputSchema>;
