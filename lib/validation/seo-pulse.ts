import { z } from "zod";
import { APPLY_FIELDS, SLUG_PATTERN } from "@/lib/seo-pulse/types";

/** Starting a run. The key is one per click, so a retried request is one run. */
export const seoPulseRunSchema = z
  .object({
    requestKey: z.string().uuid(),
    /** True asks for new research even when recent research matches. */
    fresh: z.boolean().default(false),
  })
  .strict();

/**
 * Applying recommendations. Every value here is what staff reviewed and
 * possibly edited — not what the run said — and `overwrite` names the fields
 * they explicitly chose to replace. The server refuses to replace a field
 * that already holds something unless it is named there.
 */
export const seoPulseApplySchema = z
  .object({
    runId: z.string().uuid(),
    fields: z
      .object({
        seoFocusKeyword: z.string().trim().min(1).max(80).optional(),
        seoMetaTitle: z.string().trim().min(1).max(200).optional(),
        seoMetaDescription: z.string().trim().min(1).max(400).optional(),
        slug: z
          .string()
          .trim()
          .max(80)
          .regex(SLUG_PATTERN, "Use lowercase letters, numbers, and single hyphens.")
          .optional(),
        title: z.string().trim().min(1).max(200).optional(),
        descriptionHtml: z.string().trim().min(1).max(20_000).optional(),
        tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
        searchKeywords: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
        bulletFeatures: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
        /* Rows derived from the product's own recorded facts (D-043). */
        specTable: z
          .array(
            z
              .object({
                label: z.string().trim().min(1).max(120),
                value: z.string().trim().min(1).max(300),
              })
              .strict(),
          )
          .max(50)
          .optional(),
        measurements: z
          .array(
            z
              .object({
                label: z.string().trim().min(1).max(120),
                value: z.string().trim().min(1).max(300),
              })
              .strict(),
          )
          .max(30)
          .optional(),
        imageAlts: z
          .array(
            z
              .object({
                imageId: z.string().uuid(),
                altText: z.string().trim().min(1).max(250),
              })
              .strict(),
          )
          .max(30)
          .optional(),
        synonyms: z
          .array(
            z
              .object({
                term: z.string().trim().min(1).max(60),
                synonyms: z.array(z.string().trim().min(1).max(60)).min(1).max(12),
              })
              .strict(),
          )
          .max(10)
          .optional(),
      })
      .strict(),
    overwrite: z.array(z.enum(APPLY_FIELDS)).max(APPLY_FIELDS.length).default([]),
  })
  .strict();

export type SeoPulseApplyPayload = z.infer<typeof seoPulseApplySchema>;

export const seoPulseExportFormat = z.enum(["json", "csv", "html"]);
