import type { SessionUser } from "@/lib/auth/session";
import { listProductOptions, listVariants } from "@/lib/catalog";
import type { ManagerOption, ManagerPhoto, ManagerVariant } from "./variant-matrix";

/** yyyy-mm-dd, which is what a date input expects. */
function dateInputValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

/**
 * Everything the variants manager needs for one product — its own options,
 * its variants and the photographs a variant may use. Shared by the product
 * editor's wizard step and the standalone variants page, so both show the
 * same product-owned data (D-040).
 */
export async function loadVariantManager(
  user: SessionUser,
  product: {
    id: string;
    title: string;
    images: { id: string; url: string; altText: string }[];
    lifestyleImages: { id: string; url: string; altText: string }[];
  },
): Promise<{
  productId: string;
  productTitle: string;
  options: ManagerOption[];
  variants: ManagerVariant[];
  photos: ManagerPhoto[];
}> {
  const [options, variants] = await Promise.all([
    listProductOptions(product.id),
    listVariants(user, product.id),
  ]);

  return {
    productId: product.id,
    productTitle: product.title,
    options: options.map((option) => ({
      id: option.id,
      name: option.name,
      values: option.values.map((value) => ({ id: value.id, value: value.value })),
    })),
    photos: [...product.images, ...product.lifestyleImages].map((image) => ({
      id: image.id,
      url: image.url,
      altText: image.altText,
    })),
    variants: variants.map((variant) => ({
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
    })),
  };
}
