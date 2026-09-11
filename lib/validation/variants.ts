import { z } from "zod";

export const generateVariantsSchema = z
  .object({
    productId: z.string().uuid(),
    attributeIds: z.array(z.string().uuid()).max(6),
    priceBdt: z.number().int().min(0).max(100_000_000),
    fulfillmentMode: z.enum(["in_stock", "preorder"]).default("preorder"),
    /** Remove variants that no longer match the options (D-040). */
    prune: z.boolean().optional(),
  })
  .strict();

export const variantUpdateSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .min(1, "Enter a SKU.")
      .max(64)
      .regex(
        /^[A-Za-z0-9._\-\/]+$/,
        "Use letters, numbers, dots, dashes, slashes and underscores.",
      )
      .optional(),
    priceBdt: z.number().int().min(0).max(100_000_000).optional(),
    /** Null clears the sale and puts the regular price back. */
    salePriceBdt: z.number().int().min(0).max(100_000_000).nullable().optional(),
    saleStartsAt: z.coerce.date().nullable().optional(),
    saleEndsAt: z.coerce.date().nullable().optional(),
    lowStockThreshold: z.number().int().min(0).max(1_000_000).nullable().optional(),
    costPriceUsd: z.number().int().min(0).max(100_000_000).nullable().optional(),
    isEnabled: z.boolean().optional(),
    fulfillmentMode: z.enum(["in_stock", "preorder"]).optional(),
    stockQuantity: z.number().int().min(0).nullable().optional(),
    preorderCapacity: z.number().int().min(0).nullable().optional(),
    preorderClosesAt: z.coerce.date().nullable().optional(),
    paymentMode: z.enum(["full", "deposit"]).optional(),
    depositPercent: z.number().int().min(1).max(99).nullable().optional(),
    estimatedArrivalFrom: z.coerce.date().nullable().optional(),
    estimatedArrivalTo: z.coerce.date().nullable().optional(),
    weightGrams: z.number().int().min(0).nullable().optional(),
  })
  .strict();

/** One variant added by hand: a value per option, and a starting price. */
export const addVariantSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            attributeId: z.string().uuid(),
            value: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .max(6),
    priceBdt: z.number().int().min(0).max(100_000_000),
    fulfillmentMode: z.enum(["in_stock", "preorder"]).default("preorder"),
  })
  .strict();

export const attributeValueSchema = z
  .object({ value: z.string().trim().min(1, "Enter a value.").max(120) })
  .strict();

export const bulkVariantUpdateSchema = z
  .object({
    variantIds: z.array(z.string().uuid()).min(1).max(500),
    update: variantUpdateSchema,
  })
  .strict();
