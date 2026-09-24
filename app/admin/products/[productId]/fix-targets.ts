/**
 * Where each publishing check is fixed: the editor section, and the field to
 * focus when there is one. Shared by the action bar and the checklist box.
 */
export const FIX_TARGETS: Record<string, { section: string; field?: string }> = {
  category: { section: "identity", field: "categoryId" },
  image: { section: "media", field: "file-gallery" },
  variant: { section: "selling" },
  price: { section: "selling" },
  capacity: { section: "selling" },
  arrival: { section: "selling" },
  description: { section: "content", field: "descriptionHtml" },
  seo: { section: "seo", field: "seoMetaDescription" },
};

/** Opens the section that fixes a check and focuses its field. */
export function openFix(checkId: string) {
  const target = FIX_TARGETS[checkId];
  if (!target) return;
  window.dispatchEvent(new CustomEvent("product-editor:open", { detail: target }));
}
