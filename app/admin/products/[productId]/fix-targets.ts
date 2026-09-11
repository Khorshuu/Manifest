/**
 * Where each publishing check is fixed: the editor section, and the field to
 * focus when there is one. Shared by the action bar and the checklist box.
 */
export const FIX_TARGETS: Record<string, { section: string; field?: string }> = {
  category: { section: "basics", field: "categoryId" },
  image: { section: "media", field: "file-gallery" },
  variant: { section: "variants" },
  price: { section: "variants" },
  capacity: { section: "variants" },
  arrival: { section: "variants" },
  description: { section: "information", field: "descriptionHtml" },
  seo: { section: "information", field: "seoMetaDescription" },
};

/** Opens the section that fixes a check and focuses its field. */
export function openFix(checkId: string) {
  const target = FIX_TARGETS[checkId];
  if (!target) return;
  window.dispatchEvent(new CustomEvent("product-editor:open", { detail: target }));
}
