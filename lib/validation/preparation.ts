import { z } from "zod";
import { productIdentitySchema } from "./catalog";

/**
 * What a preparation request may carry (D-112).
 *
 * Deliberately small. Everything a run needs beyond the product itself is one
 * of three things: identity the manufacturer would recognise, an address to
 * read, or a document somebody holds. Each goes in through the path that
 * already validates it, so nothing here re-states a rule that lives elsewhere.
 *
 * Documents are text. The extraction step reads HTML, JSON-LD and plain text;
 * it does not read binary formats and there is no optical recognition, so a
 * PDF specification is pasted as text rather than uploaded. That contract is
 * the existing one (`provideDocument`) and this does not change it.
 */
export const preparationDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(400_000),
    contentType: z.enum(["text/plain", "text/html", "application/json"]).optional(),
    url: z.string().url().max(2000).nullish(),
  })
  .strict();

export const preparationStartSchema = z
  .object({
    /** One click's key, so a retried request returns the run it already made. */
    requestKey: z.string().uuid(),
    identity: productIdentitySchema.optional(),
    urls: z.array(z.string().url().max(2000)).max(10).optional(),
    document: preparationDocumentSchema.optional(),
  })
  .strict();

export const preparationActionSchema = z
  .object({
    action: z.enum(["retry", "cancel", "continue"]),
    identity: productIdentitySchema.optional(),
    urls: z.array(z.string().url().max(2000)).max(10).optional(),
    document: preparationDocumentSchema.optional(),
  })
  .strict();

export type PreparationStartPayload = z.infer<typeof preparationStartSchema>;
export type PreparationActionPayload = z.infer<typeof preparationActionSchema>;
