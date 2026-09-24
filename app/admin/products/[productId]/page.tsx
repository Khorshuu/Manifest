import type { Metadata } from "next";
import { IconArrowLeft } from "@/components/icons";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getCategoryTree,
  getProductForAdmin,
  getReadiness,
  listProductOptions,
  listVariants,
  PUBLIC_STATUSES,
  resolveCategoryAttributes,
  type CategoryNode,
} from "@/lib/catalog";
import type {
  ProductCompliance,
  ProductDetails,
  ProductWarranty,
} from "@/db/schema";
import { ProductActionBar } from "./product-action-bar";
import { ProductEditor, type EditorSection } from "./product-editor";
import { PreparationPanel } from "./preparation-panel";
import { PublishingReadinessBox } from "./publishing-readiness-box";
import { SeoPulseBox } from "./seo-pulse-box";
import { SearchPerformanceBox } from "./search-performance-box";
import { SeoReadinessBox } from "./seo-readiness-box";
import { db } from "@/db";
import { listingAudit } from "@/lib/seo/audit";
import { listingSearchPerformance } from "@/lib/search-console/listing";
import { fieldStates, seoFieldLabel } from "@/lib/seo/fields";
import { slugHistory } from "@/lib/seo/redirects";
import { SEO_FIELDS } from "@/db/schema";
import { AssuranceSection } from "./sections/assurance-section";
import { BasicsSection } from "./sections/basics-section";
import { ContentSection } from "./sections/content-section";
import { MediaSection } from "./sections/media-section";
import { SellingSection } from "./sections/selling-section";
import { SeoSection } from "./sections/seo-section";
import { SpecsSection } from "./sections/specs-section";
import { VisibilitySection } from "./sections/visibility-section";
import { VariantMatrix } from "./variants/variant-matrix";
import { requireAdminPage } from "@/lib/auth/admin-page";
import {
  describeDataProvider,
  describeIntelligenceProvider,
  getSeoPulseOverview,
} from "@/lib/seo-pulse";
import { getPreparation } from "@/lib/preparation";
import { describeIdentityState } from "@/lib/preparation/presentation";
import { getProductResearchProvider } from "@/lib/providers/research";
import { eq } from "drizzle-orm";
import { pkbProducts } from "@/db/schema";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

/** Flattens the tree into indented options, so nesting is visible in a select. */
function flatten(nodes: CategoryNode[]): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` },
    ...flatten(node.children),
  ]);
}

function findName(nodes: CategoryNode[], id: string): string | null {
  for (const node of nodes) {
    if (node.id === id) return node.name;
    const inside = findName(node.children, id);
    if (inside) return inside;
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** What a datetime-local input expects, in the server's own zone. */
function dateTimeValue(date: Date | null): string {
  if (!date) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** yyyy-mm-dd, which is what a date input expects. */
function dateInputValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

/** Older links name sections that were renamed or merged (D-040). */
const SECTION_ALIASES: Record<string, string> = {
  basics: "identity",
  inventory: "selling",
  pricing: "selling",
  variations: "selling",
  variants: "selling",
  information: "content",
  "seo-pulse": "seo",
  publishing: "visibility",
};

export const metadata: Metadata = { title: "Product" };

/**
 * The product editor (D-039, D-040): the facts on the left in the order they
 * are entered — basics, media, variants with their prices and stock, product
 * information — and on the right two small boxes: SEO Pulse and what
 * publishing still needs. The sticky bar above always offers the next step.
 */
export default async function AdminProductPage({
  params,
  searchParams,
}: PageProps<"/admin/products/[productId]">) {
  const { productId } = await params;
  const query = await searchParams;
  const user = await requireAdminPage("catalog.manage");
  const product = await getProductForAdmin(user, productId);

  if (!product) notFound();

  const [tree, definitions, pulse, options, variants, checks, preparation] = await Promise.all([
    getCategoryTree(),
    // The specifications this product's category asks for — its own and
    // everything inherited from its ancestors.
    resolveCategoryAttributes(product.categoryId),
    getSeoPulseOverview(user, product.id),
    listProductOptions(product.id),
    listVariants(user, product.id),
    getReadiness(user, product.id),
    /*
     * The latest preparation run, read on the server so a refresh in the
     * middle of one comes back to the same run rather than to an empty panel
     * that then fills in (D-116). The panel never starts a run itself.
     */
    getPreparation(user, product.id),
  ]);
  const categories = flatten(tree);

  // How settled this product's identity is, as the knowledge base last
  // assessed it. Read, never written from here.
  const [knowledge] = product.pkbProductId
    ? await db
        .select({ resolutionState: pkbProducts.resolutionState })
        .from(pkbProducts)
        .where(eq(pkbProducts.id, product.pkbProductId))
    : [];
  const identityStatus = describeIdentityState(knowledge?.resolutionState ?? null);
  const discoveryConfigured = getProductResearchProvider().key !== "none";

  const warranty = (product.warranty as ProductWarranty | null) ?? null;
  const compliance = (product.compliance as ProductCompliance | null) ?? null;
  const details = (product.details as ProductDetails | null) ?? null;

  const archived = product.archivedAt !== null || product.status === "archived";
  const live = !archived && (PUBLIC_STATUSES as readonly string[]).includes(product.status);
  const data = describeDataProvider();
  const ai = describeIntelligenceProvider();

  // Panels holding their own state remount when SEO Pulse fills fields, so
  // they show the new values — and only then.
  const appliedKey =
    pulse?.history
      .map((run) => run.appliedAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? "none";

  const requested = typeof query.section === "string" ? query.section : undefined;
  const initialSection = requested ? (SECTION_ALIASES[requested] ?? requested) : undefined;

  /*
   * The editor's order of work (D-116): who this product is, what it says,
   * what it is made of, what it looks like, what it costs, how it is found,
   * and only then the optional panels. It is the order a product-entry
   * employee actually fills a product in, and it is the order SeoPulse
   * prepares it in, so the two read the same way.
   *
   * Every panel below is an existing one. Nothing was rewritten to reorder
   * them, and no field moved to a second form: the Manifest SKU left Product
   * identity for Selling information because it is commercial data and not
   * manufacturer identity, and that is the only field that changed panel.
   */
  const sections: EditorSection[] = [
    {
      id: "identity",
      label: "Product identity",
      summary: "Which product this is: what it is called, who makes it, and the numbers that tell versions apart.",
      content: (
        <BasicsSection
          key={`${archived ? "archived" : "live"}-${appliedKey}`}
          categories={categories}
          identityStatus={identityStatus}
          intelligenceHref={`/admin/products/${product.id}/intelligence`}
          product={{
            id: product.id,
            title: product.title,
            slug: product.slug,
            categoryId: product.categoryId,
            brand: product.brand,
            sku: product.sku,
            identifierType: product.identifierType,
            identifierValue: product.identifierValue,
            modelName: (details?.modelName as string | undefined) ?? null,
            modelNumber: (details?.modelNumber as string | undefined) ?? null,
            mpn: (details?.manufacturerPartNumber as string | undefined) ?? null,
            status: product.status,
            archived,
          }}
        />
      ),
    },
    {
      id: "content",
      label: "Product content",
      summary: "The key features and description a shopper reads. Anything SeoPulse prepared is yours to edit.",
      content: (
        <ContentSection
          key={appliedKey}
          product={{
            id: product.id,
            descriptionHtml: product.descriptionHtml,
            bulletFeatures: stringList(product.bulletFeatures),
            boxContents: stringList(product.boxContents),
          }}
        />
      ),
    },
    {
      id: "specifications",
      label: "Specifications",
      summary:
        "What this product's category asks for. Leave anything you do not know blank — an unknown fact is better than a wrong one.",
      content: (
        <SpecsSection
          categoryName={findName(tree, product.categoryId) ?? "This category"}
          definitions={definitions}
          product={{
            id: product.id,
            attributeValues: (product.attributeValues as Record<string, string | string[]>) ?? {},
            details: (details ?? {}) as Record<string, string | null>,
            specTable: (product.specTable as { label: string; value: string }[] | null) ?? [],
            measurements:
              (product.measurements as { label: string; value: string }[] | null) ?? [],
          }}
        />
      ),
    },
    {
      id: "media",
      label: "Images",
      summary: "At least one photograph is required. The first is the main image; drag to reorder. Variant photos are chosen below.",
      content: (
        <MediaSection
          key={appliedKey}
          productId={product.id}
          videoUrl={product.videoUrl}
          images={product.images.map((image) => ({ id: image.id, url: image.url, altText: image.altText }))}
          lifestyleImages={product.lifestyleImages.map((image) => ({ id: image.id, url: image.url, altText: image.altText }))}
        />
      ),
    },
    {
      id: "selling",
      label: "Selling information",
      summary:
        "What this shop charges, holds and promises: your SKU, then each version's price, stock and preorder terms. None of this comes from research.",
      content: (
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <h3 className="text-meta font-semibold uppercase tracking-[0.08em] text-ink/70">Your reference</h3>
            <SellingSection key={appliedKey} product={{ id: product.id, sku: product.sku }} />
          </div>
          <div className="flex flex-col gap-3 border-t border-blue-200 pt-6">
            <h3 className="text-meta font-semibold uppercase tracking-[0.08em] text-ink/70">
              Variants, pricing &amp; stock
            </h3>
            <p className="max-w-[70ch] text-meta text-ink/65">
              What this product comes in, and what each version costs and holds. A new product starts with none.
            </p>
            <VariantMatrix
              productId={product.id}
              productTitle={product.title}
              options={options.map((option) => ({
                id: option.id,
                name: option.name,
                values: option.values.map((value) => ({ id: value.id, value: value.value })),
              }))}
              photos={[...product.images, ...product.lifestyleImages].map((image) => ({
                id: image.id,
                url: image.url,
                altText: image.altText,
              }))}
              variants={variants.map((variant) => ({
                id: variant.id,
                sku: variant.sku,
                label: variant.label,
                priceBdt: variant.priceBdt,
                salePriceBdt: variant.salePriceBdt,
                isEnabled: variant.isEnabled,
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
                archived: variant.archivedAt !== null,
                imageUrl: variant.imageUrl,
                imageId: variant.imageId,
              }))}
            />
          </div>
        </div>
      ),
    },
    {
      id: "seo",
      label: "SEO & search",
      summary: "How shoppers find this product. SeoPulse prepares these; change anything that does not sound like you.",
      content: (
        <SeoSection
          key={appliedKey}
          product={{
            id: product.id,
            title: product.title,
            slug: product.slug,
            seoMetaTitle: product.seoMetaTitle,
            seoMetaDescription: product.seoMetaDescription,
            searchKeywords: stringList(product.searchKeywords),
            tags: stringList(product.tags),
            seoNoIndex: product.seoNoIndex,
            canonicalUrl: product.canonicalUrl,
            searchable: product.searchable,
            searchBoost: product.searchBoost,
          }}
        />
      ),
    },
    {
      id: "assurance",
      label: "Warranty & safety",
      summary: "Optional. Anything left blank stays off the product page.",
      collapsible: true,
      content: (
        <AssuranceSection
          product={{
            id: product.id,
            warranty: warranty
              ? {
                  hasWarranty: warranty.hasWarranty,
                  durationMonths: warranty.durationMonths ?? null,
                  type: warranty.type ?? null,
                  provider: warranty.provider ?? null,
                  description: warranty.description ?? null,
                  terms: warranty.terms ?? null,
                }
              : null,
            compliance: compliance
              ? {
                  certifications: (compliance.certifications ?? []).map((entry) => ({
                    name: entry.name,
                    number: entry.number ?? null,
                  })),
                  compliance: compliance.compliance ?? null,
                  safety: compliance.safety ?? null,
                  warnings: compliance.warnings ?? null,
                  countryOfOrigin: compliance.countryOfOrigin ?? null,
                  regulatory: compliance.regulatory ?? null,
                }
              : null,
          }}
        />
      ),
    },
    {
      id: "visibility",
      label: "Visibility & schedule",
      summary: "How it is offered while live, scheduled dates, and archiving.",
      collapsible: true,
      content: (
        <div className="flex flex-col gap-6">
          <VisibilitySection
            productId={product.id}
            status={product.status}
            live={live}
            archived={archived}
            publishAt={dateTimeValue(product.publishAt)}
            unpublishAt={dateTimeValue(product.unpublishAt)}
          />
          <p className="max-w-[70ch] border-t border-blue-300 pt-6 text-meta text-ink/70">
            To feature this product on the homepage, link a slide or a showcase tile to{" "}
            <code className="font-mono">/products/{product.slug}</code> in{" "}
            <Link href="/admin/homepage" className="text-blue-600 underline underline-offset-4">
              homepage settings
            </Link>
            .
          </p>
        </div>
      ),
    },
  ];

  const createdNotice = query.created === "1" || query.created === "copy";
  const lastRun = pulse?.latest ?? null;

  /*
   * Which SEO fields are a person's own, and which addresses this listing has
   * had (D-077, D-078). Read here so the panel is server-rendered with the
   * rest of the editor.
   */
  const [states, previousAddresses, audit, searchPerformance] = await Promise.all([
    fieldStates(db, product.id),
    slugHistory(db, product.id),
    listingAudit(user, { productId: product.id, title: product.title }),
    listingSearchPerformance(user, product.id),
  ]);
  const LOCKABLE = ["seoMetaTitle", "seoMetaDescription", "seoFocusKeyword", "descriptionHtml", "slug"] as const;
  const fieldStateRows = SEO_FIELDS.filter((field) => (LOCKABLE as readonly string[]).includes(field)).map((field) => ({
    field,
    label: seoFieldLabel(field),
    state: states.get(field)?.state ?? ("AUTO" as const),
  }));

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-2 text-meta text-blue-600 underline-offset-4 hover:underline"
        >
          <IconArrowLeft size={16} />
          Products
        </Link>
        <h1 className="mt-2 admin-h1 text-[1.625rem]">{product.title}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink/65">
          <span className="font-mono">/products/{product.slug}</span>
          {product.sku ? <span>SKU {product.sku}</span> : null}
          <span>{product.brand ?? "No brand"}</span>
          <Link
            href={`/admin/products/${product.id}/wizard?step=basics`}
            className="text-blue-600 underline-offset-4 hover:underline"
          >
            Guided setup
          </Link>
          <Link
            href={`/admin/products/${product.id}/windows`}
            className="text-blue-600 underline-offset-4 hover:underline"
          >
            Preorder windows
          </Link>
        </p>
      </div>

      <ProductActionBar
        productId={product.id}
        slug={product.slug}
        title={product.title}
        status={product.status}
        live={live}
        archived={archived}
        justCreated={createdNotice}
      />

      {/*
       * Preparation is the first thing on the page because it is the first
       * thing that happens to a product (D-116). It reports its own state and
       * asks for what it needs; it never starts itself.
       */}
      <PreparationPanel
        productId={product.id}
        discoveryConfigured={discoveryConfigured}
        justStarted={query.preparing === "1"}
        initialRun={
          preparation
            ? {
                id: preparation.id,
                stage: preparation.stage,
                steps: preparation.steps,
                review: preparation.review,
                failure: preparation.failure,
                seoRunId: preparation.seoRunId,
                updatedAt: preparation.updatedAt.toISOString(),
              }
            : null
        }
      />

      <div className="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_17.5rem]">
        <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-24 lg:order-2">
          <PublishingReadinessBox checks={checks} audit={audit} />
          <SearchPerformanceBox performance={searchPerformance} />
          {pulse ? (
            <SeoReadinessBox
              productId={product.id}
              seo={pulse.current.seo}
              search={pulse.current.search}
              fieldStates={fieldStateRows}
              previousAddresses={previousAddresses.map((row: { fromSlug: string }) => row.fromSlug)}
            />
          ) : null}
          {/*
           * Advanced tools, folded away (D-116). Everything that used to
           * compete for attention up here still works and is still one click
           * from the product — it is simply no longer the way a normal staff
           * member is expected to prepare a listing.
           */}
          <details className="admin-card p-3.5">
            <summary className="cursor-pointer text-[0.8125rem] font-medium text-ink">Advanced tools</summary>
            <div className="mt-3 flex flex-col gap-3">
              <Link
                className="text-[0.8rem] text-blue-600 hover:underline"
                href={`/admin/products/${product.id}/intelligence`}
              >
                Open product intelligence
              </Link>
              <p className="text-[0.75rem] text-ink/65">
                The facts behind this listing, where each came from, and anything waiting for a decision.
              </p>
              <SeoPulseBox
                productId={product.id}
                lastRunId={lastRun?.id ?? null}
                lastRunAt={lastRun ? (lastRun.completedAt ?? lastRun.createdAt) : null}
                stale={Boolean(pulse && (pulse.stale || pulse.inputChanged))}
                paid={data.paid || ai.paid}
              />
            </div>
          </details>
        </aside>
        <div className="min-w-0 lg:order-1">
          <ProductEditor sections={sections} initialSection={initialSection} />
        </div>
      </div>
    </div>
  );
}
