import { z } from "zod";
import { addressInputSchema } from "./cart";

export const wishlistInputSchema = z
  .object({ variantId: z.string().uuid() })
  .strict();

export const saveForLaterSchema = z
  .object({ itemId: z.string().uuid() })
  .strict();

export const moveToCartSchema = z
  .object({ variantId: z.string().uuid() })
  .strict();

export const accountAddressSchema = addressInputSchema
  .extend({
    label: z.string().trim().max(40).optional(),
    makeDefault: z.boolean().optional(),
  })
  .strict();

export const newsletterSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  })
  .strict();
