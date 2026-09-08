import { z } from "zod";

export const addToCartSchema = z
  .object({
    variantId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99),
  })
  .strict();

export const updateCartItemSchema = z
  .object({
    itemId: z.string().uuid(),
    quantity: z.number().int().min(0).max(99),
  })
  .strict();

export const addressInputSchema = z
  .object({
    recipientName: z.string().trim().min(1, "Enter the recipient's name.").max(120),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{10,15}$/, "Enter a phone number with 10 to 15 digits."),
    addressLine1: z.string().trim().min(1, "Enter the street address.").max(200),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1, "Enter the city.").max(120),
    district: z.string().trim().min(1, "Enter the district.").max(120),
    postalCode: z.string().trim().max(20).optional(),
  })
  .strict();

export const placeOrderSchema = z
  .object({
    /* Note what is absent: no price, no total, no quantity of anything. The
       server derives every amount from the cart it holds. */
    shippingAddressId: z.string().uuid().optional(),
    address: addressInputSchema.optional(),
    method: z.enum([
      "card",
      "bkash",
      "nagad",
      "rocket",
      "bank_transfer",
      "cod",
    ]),
    email: z.string().trim().toLowerCase().email("Enter a valid email address."),
    phone: z.string().trim().max(20).optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
