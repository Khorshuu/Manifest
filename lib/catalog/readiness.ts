import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { productImages, productVariants, products } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { PUBLIC_STATUSES } from "./products";

/**
 * Whether a product is fit to be published.
 *
 * These are checked on the server at the moment of publishing, not only shown
 * in the wizard. A publish that skipped the wizard, or a stale page, must not
 * be able to put a priceless, pictureless listing in front of a shopper
 * (docs/BUSINESS_LOGIC.md).
 */

export type ReadinessCheck = {
  id: string;
  label: string;
  /** What to do about it, in the words of the person who has to do it. */
  hint: string;
  passed: boolean;
  /** A failed required check blocks publishing; an advisory one does not. */
  required: boolean;
};

export class NotReadyError extends Error {
  readonly status = 409;
  readonly failures: string[];
  /** The failing checks themselves, so a screen can point at each one. */
  readonly checks: ReadinessCheck[];

  constructor(failures: string[], checks: ReadinessCheck[] = []) {
    super(
      `This product is not ready to publish: ${failures.join("; ")}.`,
    );
    this.name = "NotReadyError";
    this.failures = failures;
    this.checks = checks;
  }
}

export async function getReadiness(
  actor: SessionUser | null,
  productId: string,
): Promise<ReadinessCheck[]> {
  requirePermission(actor, "catalog.manage");

  const [product] = await db
    .select({
      id: products.id,
      title: products.title,
      descriptionHtml: products.descriptionHtml,
      bulletFeatures: products.bulletFeatures,
      seoMetaTitle: products.seoMetaTitle,
      seoMetaDescription: products.seoMetaDescription,
      categoryId: products.categoryId,
    })
    .from(products)
    .where(eq(products.id, productId));

  if (!product) throw new Error("That product no longer exists.");

  const [imageCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(productImages)
    .where(eq(productImages.productId, productId));

  const variants = await db
    .select({
      priceBdt: productVariants.priceBdt,
      fulfillmentMode: productVariants.fulfillmentMode,
      preorderCapacity: productVariants.preorderCapacity,
      preorderClosesAt: productVariants.preorderClosesAt,
      estimatedArrivalFrom: productVariants.estimatedArrivalFrom,
      paymentMode: productVariants.paymentMode,
      depositPercent: productVariants.depositPercent,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.isEnabled, true),
        isNull(productVariants.archivedAt),
      ),
    );

  const preorders = variants.filter(
    (variant) => variant.fulfillmentMode === "preorder",
  );

  const bullets = Array.isArray(product.bulletFeatures)
    ? (product.bulletFeatures as string[])
    : [];

  return [
    {
      id: "category",
      label: "It belongs to a category",
      hint: "Choose a category on the first step. Nothing can be browsed to without one.",
      passed: Boolean(product.categoryId),
      required: true,
    },
    {
      id: "image",
      label: "It has at least one photograph",
      hint: "Add a photograph. A listing with no image is the one shoppers skip.",
      passed: (imageCount?.value ?? 0) > 0,
      required: true,
    },
    {
      id: "variant",
      label: "It has something to buy",
      hint: "Generate at least one variant and leave it enabled.",
      passed: variants.length > 0,
      required: true,
    },
    {
      id: "price",
      label: "Every variant on sale has a price",
      hint: "Set a price above zero on the pricing step. A zero price would be charged as zero.",
      passed:
        variants.length > 0 &&
        variants.every((variant) => variant.priceBdt > 0),
      required: true,
    },
    {
      id: "capacity",
      label: "Every preorder has a capacity and a closing date",
      hint: "A preorder with no ceiling can be oversold, and one with no closing date never resolves.",
      passed: preorders.every(
        (variant) =>
          variant.preorderCapacity !== null && variant.preorderClosesAt !== null,
      ),
      required: true,
    },
    // A deposit variant without a percentage is refused by the
    // product_variants_deposit_requires_percent_check constraint, so there is
    // no check for it here — it cannot reach this code.
    {
      id: "arrival",
      label: "Preorders state when they should arrive",
      hint: "Shoppers are being asked to wait months. Give them a window on the pricing step.",
      passed: preorders.every(
        (variant) => variant.estimatedArrivalFrom !== null,
      ),
      required: false,
    },
    {
      id: "description",
      label: "It is described",
      hint: "Add a description or key points on the first step.",
      passed: Boolean(product.descriptionHtml?.trim()) || bullets.length > 0,
      required: false,
    },
    {
      id: "seo",
      label: "It has a search listing",
      hint: "Write a meta description on the SEO step so the search result reads well.",
      passed: Boolean(product.seoMetaDescription?.trim()),
      required: false,
    },
  ];
}

export type ReadinessSummary = {
  checks: ReadinessCheck[];
  canPublish: boolean;
  /** Advisory checks that failed — worth saying, not worth blocking. */
  warnings: string[];
};

export async function getReadinessSummary(
  actor: SessionUser | null,
  productId: string,
): Promise<ReadinessSummary> {
  const checks = await getReadiness(actor, productId);

  return {
    checks,
    canPublish: checks.every((check) => !check.required || check.passed),
    warnings: checks
      .filter((check) => !check.required && !check.passed)
      .map((check) => check.label),
  };
}

/**
 * Publishes, or refuses with the reasons. The same check runs here as the
 * wizard shows, so the screen and the rule cannot disagree.
 */
export async function publishProduct(
  actor: SessionUser | null,
  productId: string,
  status: string,
) {
  const staff = requirePermission(actor, "catalog.manage");

  if (!(PUBLIC_STATUSES as readonly string[]).includes(status)) {
    throw new NotReadyError([`${status} is not a status shoppers can see`]);
  }

  const checks = await getReadiness(actor, productId);
  const failing = checks.filter((check) => check.required && !check.passed);

  if (failing.length > 0) {
    throw new NotReadyError(
      failing.map((check) => check.label.toLowerCase()),
      failing,
    );
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ status: products.status })
      .from(products)
      .where(eq(products.id, productId));

    if (!before) throw new Error("That product no longer exists.");

    const [updated] = await tx
      .update(products)
      .set({ status, archivedAt: null, updatedAt: new Date() })
      .where(eq(products.id, productId))
      .returning({ id: products.id, status: products.status });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "product.updated",
        entityType: "product",
        entityId: productId,
        before: { status: before.status },
        after: { status },
      },
      tx,
    );

    return updated;
  });
}
