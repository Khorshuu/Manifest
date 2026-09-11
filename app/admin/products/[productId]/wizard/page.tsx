import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import {
  getCategoryTree,
  getProductForAdmin,
  getReadinessSummary,
  listVariants,
  type CategoryNode,
} from "@/lib/catalog";
import { ImageManager } from "../image-manager";
import { SeoPulseBox } from "../seo-pulse-box";
import { loadVariantManager } from "../variants/manager-props";
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
import { requireAdminPage } from "@/lib/auth/admin-page";
import {
  describeDataProvider,
  describeIntelligenceProvider,
  getSeoPulseOverview,
} from "@/lib/seo-pulse";

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

  const user = await requireAdminPage("catalog.manage");
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
        <p className="flex flex-wrap items-center gap-2 text-meta text-ink/70">
          <Link href="/admin/products" className="text-blue-600 underline-offset-4 hover:underline">
            Products
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            href={`/admin/products/${productId}`}
            className="text-blue-600 underline-offset-4 hover:underline"
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
                className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body surface-brass sheen text-ink shadow-[var(--shadow-raise)] hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04]"
              >
                Continue
              </Link>
            </div>
          </div>
        ) : null}

        {step === "variations" ? (
          <div className="flex min-w-0 flex-col gap-6">
            <p className="max-w-[70ch] text-meta text-ink/70">
              Add a variant group (Color, Size…) if this product comes in
              versions, then set each one&rsquo;s price and stock. A product
              with no groups still has one variant — set its price here.
            </p>
            <VariantMatrix {...(await loadVariantManager(user, product))} />
            <div>
              <Link
                href={nextHref}
                className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body surface-brass sheen text-ink shadow-[var(--shadow-raise)] hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04]"
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
                salePriceTaka:
                  variant.salePriceBdt === null
                    ? ""
                    : (variant.salePriceBdt / 100).toFixed(2),
                saleStartsAt: dateInputValue(variant.saleStartsAt),
                saleEndsAt: dateInputValue(variant.saleEndsAt),
                fulfillmentMode: variant.fulfillmentMode,
                stockQuantity: variant.stockQuantity,
                lowStockThreshold: variant.lowStockThreshold,
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
          <div className="flex min-w-0 flex-col gap-8">
            <SeoForm
              key={product.updatedAt.toISOString()}
              product={{ ...basics, slug: product.slug }}
              nextHref={nextHref}
            />
            {await (async () => {
              const pulse = await getSeoPulseOverview(user, productId);
              if (!pulse) return null;
              const last = pulse.latest;
              return (
                <div className="max-w-sm border-t border-blue-300 pt-6">
                  <SeoPulseBox
                    productId={product.id}
                    lastRunId={last?.id ?? null}
                    lastRunAt={last ? (last.completedAt ?? last.createdAt) : null}
                    stale={pulse.stale || pulse.inputChanged}
                    paid={describeDataProvider().paid || describeIntelligenceProvider().paid}
                  />
                </div>
              );
            })()}
          </div>
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
