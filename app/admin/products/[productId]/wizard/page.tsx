import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { getCurrentUser } from "@/lib/auth";
import {
  getCategoryTree,
  getProductAttributes,
  getProductForAdmin,
  getReadinessSummary,
  listAttributes,
  listVariants,
  type CategoryNode,
} from "@/lib/catalog";
import { ImageManager } from "../image-manager";
import { VariantMatrix } from "../variants/variant-matrix";
import { BasicsForm, type BasicsValues } from "./basics-form";
import { PricingTable } from "./pricing-table";
import { PublishPanel } from "./publish-panel";
import { SeoForm } from "./seo-form";
import { Stepper } from "./stepper";
import {
  isWizardStep,
  nextStep,
  previousStep,
  wizardHref,
  WIZARD_STEPS,
  type WizardStep,
} from "./steps";

export const metadata: Metadata = { title: "Product setup" };
export const dynamic = "force-dynamic";

function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

/** yyyy-mm-dd, which is what a date input expects. */
function dateInputValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

export default async function ProductWizardPage({
  params,
  searchParams,
}: PageProps<"/admin/products/[productId]/wizard">) {
  const { productId } = await params;
  const query = await searchParams;

  const step: WizardStep = isWizardStep(query.step) ? query.step : "basics";

  const user = await getCurrentUser();
  const product = await getProductForAdmin(user, productId);
  if (!product) notFound();

  const forward = nextStep(step);
  const back = previousStep(step);
  const nextHref = forward
    ? wizardHref(productId, forward)
    : `/admin/products/${productId}`;

  const basics: BasicsValues = {
    id: product.id,
    title: product.title,
    brand: product.brand,
    categoryId: product.categoryId,
    status: product.status,
    descriptionHtml: product.descriptionHtml,
    bulletFeatures: Array.isArray(product.bulletFeatures)
      ? (product.bulletFeatures as string[])
      : [],
    seoMetaTitle: product.seoMetaTitle,
    seoMetaDescription: product.seoMetaDescription,
    specTable:
      (product.specTable as { label: string; value: string }[] | null) ?? null,
    tags: (product.tags as string[] | null) ?? null,
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <p className="text-meta text-blue-400">
          <Link href="/admin/products" className="hover:underline">
            Products
          </Link>
          {" / "}
          <Link
            href={`/admin/products/${productId}`}
            className="hover:underline"
          >
            {product.title}
          </Link>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-h1 text-ink">Set up this product</h1>
          <StatusBadge tone={product.archivedAt ? "negative" : "neutral"}>
            {product.archivedAt ? "Archived" : product.status}
          </StatusBadge>
        </div>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          Step {WIZARD_STEPS.findIndex((entry) => entry.id === step) + 1} of{" "}
          {WIZARD_STEPS.length}. Everything is saved as you go, and every step
          stays reachable — come back to any of them later.
        </p>
      </div>

      <Stepper productId={productId} current={step} />

      <div className="min-w-0 border-t border-blue-300 pt-6">
        {step === "basics" ? (
          <BasicsForm
            key={product.updatedAt.toISOString()}
            product={basics}
            categories={flatten(await getCategoryTree())}
            nextHref={nextHref}
          />
        ) : null}

        {step === "images" ? (
          <div className="flex flex-col gap-6">
            <p className="max-w-[70ch] text-meta text-ink/70">
              The first photograph is the one shown on the product card and at
              the top of the product page. Square, on a plain ground.
            </p>
            <ImageManager
              productId={productId}
              images={product.images.map((image) => ({
                id: image.id,
                url: image.url,
                altText: image.altText,
              }))}
            />
            <div>
              <Link
                href={nextHref}
                className="inline-flex min-h-11 items-center rounded-control bg-brass px-4 text-body font-medium text-ink"
              >
                Continue
              </Link>
            </div>
          </div>
        ) : null}

        {step === "variations" ? (
          <div className="flex min-w-0 flex-col gap-6">
            <p className="max-w-[70ch] text-meta text-ink/70">
              Pick the attributes this product varies by, then generate the
              combinations. A product with no variations still needs one variant
              — generate with nothing selected and you get exactly that.
            </p>
            <VariantMatrix
              productId={productId}
              attributes={(await listAttributes()).map((attribute) => ({
                id: attribute.id,
                name: attribute.name,
                valueCount: attribute.values.length,
              }))}
              selectedAttributeIds={(
                await getProductAttributes(productId)
              ).map((row) => row.attributeId)}
              variants={(await listVariants(user, productId)).map((variant) => ({
                id: variant.id,
                sku: variant.sku,
                label: variant.label,
                priceBdt: variant.priceBdt,
                isEnabled: variant.isEnabled,
                fulfillmentMode: variant.fulfillmentMode,
                preorderCapacity: variant.preorderCapacity,
                preorderReserved: variant.preorderReserved,
              }))}
            />
            <div>
              <Link
                href={nextHref}
                className="inline-flex min-h-11 items-center rounded-control bg-brass px-4 text-body font-medium text-ink"
              >
                Continue
              </Link>
            </div>
          </div>
        ) : null}

        {step === "pricing" ? (
          <PricingTable
            nextHref={nextHref}
            variants={(await listVariants(user, productId))
              .filter((variant) => variant.archivedAt === null)
              .map((variant) => ({
                id: variant.id,
                sku: variant.sku,
                label: variant.label,
                // Taka in the form, paisa in the database.
                priceTaka: (variant.priceBdt / 100).toFixed(2),
                fulfillmentMode: variant.fulfillmentMode,
                stockQuantity: variant.stockQuantity,
                preorderCapacity: variant.preorderCapacity,
                preorderReserved: variant.preorderReserved,
                closesAt: dateInputValue(variant.preorderClosesAt),
                arrivesFrom: dateInputValue(variant.estimatedArrivalFrom),
                arrivesTo: dateInputValue(variant.estimatedArrivalTo),
                paymentMode: variant.paymentMode,
                depositPercent: variant.depositPercent,
              }))}
          />
        ) : null}

        {step === "seo" ? (
          <SeoForm
            key={product.updatedAt.toISOString()}
            product={{ ...basics, slug: product.slug }}
            nextHref={nextHref}
          />
        ) : null}

        {step === "publish" ? (
          <PublishPanel
            productId={productId}
            slug={product.slug}
            status={product.status}
            {...(await getReadinessSummary(user, productId))}
          />
        ) : null}
      </div>

      {back ? (
        <div>
          <Link
            href={wizardHref(productId, back)}
            className="inline-flex min-h-11 items-center text-body text-blue-600"
          >
            Back
          </Link>
        </div>
      ) : null}
    </div>
  );
}
