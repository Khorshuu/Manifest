import { sql } from "drizzle-orm";
import { db } from "@/db";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import { queryRows, type Executor } from "@/lib/pkb/common";
import { publishableKnowledge } from "@/lib/pkb/publish";
import { isGenericAlt } from "./readiness";

/**
 * Image SEO (D-085).
 *
 * Photographs are a real source of product traffic and the only part of a
 * listing a screen reader cannot read for itself. This module says, per
 * listing and across the catalogue, what is measurably wrong with the
 * photography as search sees it: a photograph with nothing describing it, the
 * same sentence pasted onto every angle, a file so small it will never be
 * shown, a file so large it slows the page that carries it.
 *
 * What it does not do is write anything. `suggestAltText` builds a sentence
 * out of facts the knowledge base has already established — the brand and the
 * product name, plus a colour or a material only when that value is VERIFIED
 * or a person typed it. It never invents a detail about a photograph it has
 * not seen ("front view", "on a wooden desk"), because alt text that describes
 * the wrong picture is worse than none at all.
 */

export type ImageFinding = {
  id: string;
  /** The photograph this is about, when it is about one. */
  imageId: string | null;
  label: string;
  /** What is actually the case. */
  detail: string;
  fix: string;
  severity: "required" | "recommended" | "optional";
};

export type ListingImageAudit = {
  productId: string;
  images: {
    id: string;
    url: string;
    altText: string;
    kind: string;
    sortOrder: number;
    width: number | null;
    height: number | null;
    bytes: number | null;
    contentType: string | null;
  }[];
  galleryCount: number;
  findings: ImageFinding[];
};

/** Below this, a photograph is too small to be shown as an image result. */
const MIN_LONGEST_EDGE = 800;
/** Above this, one photograph is a noticeable share of the page's weight. */
const HEAVY_BYTES = 600_000;
const MODERN_TYPES = ["image/webp", "image/avif"];

type ImageRow = {
  id: string;
  url: string;
  alt_text: string;
  kind: string;
  sort_order: number;
  width: number | null;
  height: number | null;
  bytes: number | null;
  content_type: string | null;
};

/**
 * Dimensions and weight come from `media_objects`, which records every file the
 * media provider stored. A photograph with no row there was not uploaded
 * through the registry (a seed, an imported address), so its size is unknown —
 * reported as unknown, never guessed at.
 */
export async function listingImageAudit(
  productId: string,
  title: string,
  executor: Executor = db,
): Promise<ListingImageAudit> {
  const rows = await queryRows<ImageRow>(
    executor,
    sql`
      select i.id, i.url, i.alt_text, i.kind, i.sort_order,
             m.width, m.height, m.bytes, m.content_type
      from product_images i
      left join media_objects m on m.url = i.url
      where i.product_id = ${productId}
      order by i.kind, i.sort_order, i.created_at
    `,
  );

  const images = rows.map((row) => ({
    id: row.id,
    url: row.url,
    altText: row.alt_text,
    kind: row.kind,
    sortOrder: row.sort_order,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    contentType: row.content_type,
  }));
  const gallery = images.filter((image) => image.kind === "gallery");
  const findings: ImageFinding[] = [];

  if (gallery.length === 0) {
    findings.push({
      id: "no_gallery_image",
      imageId: null,
      label: "No product photograph",
      detail: "the gallery is empty",
      fix: "Add at least one photograph. A product result without an image is rarely shown.",
      severity: "required",
    });
  } else if (gallery.length < 3) {
    findings.push({
      id: "few_photographs",
      imageId: null,
      label: "Fewer than three photographs",
      detail: `${gallery.length} in the gallery`,
      fix: "Shoppers compare angles before they buy, and each photograph is another way to be found in image search.",
      severity: "optional",
    });
  }

  const seenAlt = new Map<string, string>();
  for (const image of images) {
    const alt = image.altText.trim();
    if (isGenericAlt(alt, title)) {
      findings.push({
        id: `thin_alt:${image.id}`,
        imageId: image.id,
        label: "Photograph not described",
        detail: alt.length === 0 ? "no description" : `"${alt}"`,
        fix: "Describe what is in the picture, in a few words. This is what image search and a screen reader read.",
        severity: "recommended",
      });
    } else {
      const key = alt.toLowerCase();
      if (seenAlt.has(key)) {
        findings.push({
          id: `duplicate_alt:${image.id}`,
          imageId: image.id,
          label: "Two photographs described identically",
          detail: `"${alt}"`,
          fix: "Each photograph shows something different. Say what this one shows.",
          severity: "optional",
        });
      } else {
        seenAlt.set(key, image.id);
      }
    }

    if (image.width === null || image.height === null) {
      findings.push({
        id: `unknown_size:${image.id}`,
        imageId: image.id,
        label: "Image size unknown",
        detail: "no record of this file in the media registry",
        fix: "Re-upload it through the media panel so its dimensions are recorded and the page can reserve its space.",
        severity: "optional",
      });
      continue;
    }

    const longest = Math.max(image.width, image.height);
    if (longest < MIN_LONGEST_EDGE) {
      findings.push({
        id: `small_image:${image.id}`,
        imageId: image.id,
        label: "Photograph too small for an image result",
        detail: `${image.width}x${image.height}`,
        fix: `An image under ${MIN_LONGEST_EDGE}px on its longest edge is rarely shown in image search. Upload a larger original.`,
        severity: "recommended",
      });
    }
    if (image.bytes !== null && image.bytes > HEAVY_BYTES) {
      findings.push({
        id: `heavy_image:${image.id}`,
        imageId: image.id,
        label: "Photograph heavier than 600 KB",
        detail: `${Math.round(image.bytes / 1024)} KB${image.contentType ? `, ${image.contentType}` : ""}`,
        fix: "A heavy hero image delays the largest paint, which is both a ranking signal and a real wait for the shopper.",
        severity: "recommended",
      });
    }
    if (
      image.contentType &&
      !MODERN_TYPES.includes(image.contentType) &&
      image.bytes !== null &&
      image.bytes > 200_000
    ) {
      findings.push({
        id: `dated_format:${image.id}`,
        imageId: image.id,
        label: "Older image format",
        detail: `${image.contentType}, ${Math.round(image.bytes / 1024)} KB`,
        fix: "WebP or AVIF carries the same picture in a fraction of the bytes.",
        severity: "optional",
      });
    }
  }

  return { productId, images, galleryCount: gallery.length, findings };
}

/**
 * A description of the product for a photograph of it, built only from what is
 * already established: the brand, the listing's own name, and — when the
 * knowledge base has verified it or a person typed it — the colour or the
 * material. A suggestion shown to a person, never written by a job.
 */
export async function suggestAltText(
  input: { title: string; pkbProductId: string | null; position: number },
  executor: Executor = db,
): Promise<string> {
  const knowledge = await publishableKnowledge(input.pkbProductId, executor);
  const parts: string[] = [];
  if (knowledge.brand && !input.title.toLowerCase().includes(knowledge.brand.toLowerCase())) {
    parts.push(knowledge.brand);
  }
  parts.push(input.title);

  for (const property of ["color", "material"]) {
    const fact = knowledge.properties.find((entry) => entry.property === property && entry.pkbVariantId === null);
    if (fact && !parts.join(" ").toLowerCase().includes(fact.value.toLowerCase())) {
      parts.push(`in ${fact.value}`);
    }
  }

  // The position is a fact about the gallery, not a claim about the picture,
  // so it is the only thing added beyond established values.
  const suffix = input.position > 1 ? ` — photograph ${input.position}` : "";
  return `${parts.join(" ")}${suffix}`.trim();
}

export type ImageHealth = {
  /** Published, indexable listings whose photographs were examined. */
  listings: number;
  photographs: number;
  withoutDescription: number;
  duplicateDescription: number;
  tooSmall: number;
  heavy: number;
  unknownSize: number;
};

/** The same checks as one listing's audit, counted over the whole catalogue. */
export async function imageHealth(executor: Executor = db): Promise<ImageHealth> {
  const statuses = `{${PUBLIC_STATUSES.join(",")}}`;
  const [row] = await queryRows<{
    listings: number;
    photographs: number;
    without_description: number;
    duplicate_description: number;
    too_small: number;
    heavy: number;
    unknown_size: number;
  }>(
    executor,
    sql`
      with published as (
        select p.id, p.title
        from products p
        where p.archived_at is null
          and p.status = any(${statuses}::text[])
          and p.seo_no_index = false
      ),
      photos as (
        select i.id, i.product_id, btrim(i.alt_text) as alt, pub.title,
               m.width, m.height, m.bytes
        from product_images i
        join published pub on pub.id = i.product_id
        left join media_objects m on m.url = i.url
      )
      select
        (select count(*)::int from published) as listings,
        (select count(*)::int from photos) as photographs,
        (select count(*)::int from photos
          where char_length(alt) < 8
            or alt ~* '^(image|photo|picture|img|product|untitled)\\M'
            or alt ~* '\\.(jpe?g|png|webp|gif|avif)$'
            or lower(alt) = lower(btrim(title))) as without_description,
        (select coalesce(sum(extra), 0)::int from (
            select count(*) - 1 as extra
            from photos
            where char_length(alt) >= 8
            group by product_id, lower(alt)
            having count(*) > 1
          ) repeated) as duplicate_description,
        (select count(*)::int from photos
          where width is not null and height is not null
            and greatest(width, height) < ${MIN_LONGEST_EDGE}) as too_small,
        (select count(*)::int from photos where bytes > ${HEAVY_BYTES}) as heavy,
        (select count(*)::int from photos where width is null or height is null) as unknown_size
    `,
  );

  return {
    listings: row?.listings ?? 0,
    photographs: row?.photographs ?? 0,
    withoutDescription: row?.without_description ?? 0,
    duplicateDescription: row?.duplicate_description ?? 0,
    tooSmall: row?.too_small ?? 0,
    heavy: row?.heavy ?? 0,
    unknownSize: row?.unknown_size ?? 0,
  };
}
