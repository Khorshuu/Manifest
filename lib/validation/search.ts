import { z } from "zod";
import { MAX_QUERY_LENGTH, normalizeText } from "@/lib/search/normalize";

/**
 * A synonym phrase, normalised on the way in — lowercase words separated by
 * single spaces — so "Air-Pods " and "air pods" are one entry, and the stored
 * value is exactly what a normalised search is compared against.
 */
const phrase = z
  .string()
  .trim()
  .max(60, "Keep each phrase under 60 characters.")
  .transform(normalizeText)
  .pipe(
    z
      .string()
      .min(2, "Use at least two letters or digits.")
      .max(60, "Keep each phrase under 60 characters."),
  );

export const synonymInputSchema = z
  .object({
    term: phrase,
    synonyms: z
      .array(phrase)
      .min(1, "Add at least one synonym.")
      .max(12, "Twelve synonyms is the most one entry can carry."),
    bidirectional: z.boolean().default(true),
  })
  .strict()
  .transform((value) => ({
    ...value,
    synonyms: [...new Set(value.synonyms)].filter(
      (synonym) => synonym !== value.term,
    ),
  }))
  .refine((value) => value.synonyms.length > 0, {
    message: "A term cannot be its own synonym.",
    path: ["synonyms"],
  });

export type SynonymInput = z.infer<typeof synonymInputSchema>;

/** A click on a search result, sent as a beacon. */
export const searchClickSchema = z
  .object({
    q: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
    productId: z.string().uuid(),
    position: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const searchHistoryEntrySchema = z
  .object({
    q: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  })
  .strict();
