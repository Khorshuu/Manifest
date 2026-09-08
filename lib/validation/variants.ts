import { z } from "zod";

export const generateVariantsSchema = z
  .object({
    productId: z.string().uuid(),
    attributeIds: z.array(z.string().uuid()).max(6),
    priceBdt: z.number().int().min(0).max(100_000_000),
    fulfillmentMode: z.enum(["in_stock", "preorder"]).default("preorder"),
  })
  .strict();

export const variantUpdateSchema = z
  .object({
    priceBdt: z.number().int().min(0).max(100_000_000).optional(),
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

export const bulkVariantUpdateSchema = z
  .object({
    variantIds: z.array(z.string().uuid()).min(1).max(500),
    update: variantUpdateSchema,
  })
  .strict();
