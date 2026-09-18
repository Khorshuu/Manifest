import { db } from "@/db";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { Executor } from "@/lib/pkb/common";
import { listingDuplication } from "./duplicates";
import { listingImageAudit, type ImageFinding } from "./images";
import { listingTechnicalAudit, type ListingTechnicalAudit, type TechnicalFinding } from "./technical";

/**
 * One listing's page audit: the technical state, the photography and what the
 * page shares with other pages, gathered for the editor (D-087).
 *
 * The readiness panel already says what a listing's own fields are missing.
 * This answers the other half — whether the page can be indexed at all, and
 * whether it is competing with a page the same shop publishes.
 *
 * Read-only, and the permission is checked here rather than in the screen.
 */

export type ListingAudit = {
  technical: ListingTechnicalAudit | null;
  images: { findings: ImageFinding[]; galleryCount: number };
  duplication: Awaited<ReturnType<typeof listingDuplication>>;
  /** Technical and image findings together, most serious first. */
  findings: (TechnicalFinding | ImageFinding)[];
};

const RANK = { required: 0, recommended: 1, optional: 2 } as const;

export async function listingAudit(
  actor: SessionUser | null,
  input: { productId: string; title: string },
  executor: Executor = db,
): Promise<ListingAudit> {
  requirePermission(actor, "catalog.manage");

  const [technical, images, duplication] = await Promise.all([
    listingTechnicalAudit(input.productId, executor),
    listingImageAudit(input.productId, input.title, executor),
    listingDuplication(input.productId, executor),
  ]);

  const findings = [...(technical?.findings ?? []), ...images.findings].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity],
  );

  return {
    technical,
    images: { findings: images.findings, galleryCount: images.galleryCount },
    duplication,
    findings,
  };
}
