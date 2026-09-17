import { z } from "zod";

/**
 * The three things staff can do to a preorder window.
 *
 * A discriminated union rather than one shape with optional fields: "close"
 * takes nothing, and a request that closes a window while also carrying a
 * capacity is a confused request, not a lenient one. `strict()` on each member
 * means an unknown field is refused rather than quietly ignored — the same
 * rule the rest of the admin API follows (docs/SECURITY.md).
 */

const futureDate = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).getTime() > Date.now(), {
    message: "The closing date must be in the future.",
  });

export const preorderWindowSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("open"),
      /**
       * Both are required (D-058): a window without a ceiling can be oversold
       * and one without a closing date never resolves. Null is accepted by the
       * shape only so the refusal can say which one is missing
       * (lib/preorder/lifecycle.ts).
       */
      capacity: z.number().int().min(0).max(100_000).nullable(),
      closesAt: futureDate.nullable(),
    })
    .strict(),
  z.object({ action: z.literal("close") }).strict(),
  z.object({ action: z.literal("extend"), closesAt: futureDate }).strict(),
]);

export type PreorderWindowInput = z.infer<typeof preorderWindowSchema>;
