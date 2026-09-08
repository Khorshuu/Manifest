import { z } from "zod";

/**
 * A review as it arrives from the browser. The rating is the only required
 * field: someone who wants to give four stars and say nothing has still said
 * something useful.
 */
export const reviewInputSchema = z
  .object({
    productId: z.string().uuid("That product was not found."),
    rating: z.coerce
      .number()
      .int("Choose a rating from 1 to 5.")
      .min(1, "Choose a rating from 1 to 5.")
      .max(5, "Choose a rating from 1 to 5."),
    title: z.string().trim().max(120).optional(),
    body: z.string().trim().max(4000).optional(),
  })
  .strict();

export type ReviewInputPayload = z.infer<typeof reviewInputSchema>;

export const moderationSchema = z
  .object({ decision: z.enum(["approved", "rejected"]) })
  .strict();
