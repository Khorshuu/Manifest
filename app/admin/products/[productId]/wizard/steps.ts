/**
 * The wizard's spine.
 *
 * The order is the one MASTER_PRODUCT_SPEC.md section 4 names, and it is the
 * order the work actually has to happen in: there is nothing to price before
 * there are variants, and nothing to publish before there is a price.
 */

export const WIZARD_STEPS = [
  { id: "basics", label: "Basic info" },
  { id: "images", label: "Images" },
  { id: "variations", label: "Variations" },
  { id: "pricing", label: "Pricing and capacity" },
  { id: "seo", label: "SEO" },
  { id: "publish", label: "Publish" },
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number]["id"];

export function isWizardStep(value: unknown): value is WizardStep {
  return WIZARD_STEPS.some((step) => step.id === value);
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.findIndex((entry) => entry.id === step);
}

export function nextStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[stepIndex(step) + 1]?.id ?? null;
}

export function previousStep(step: WizardStep): WizardStep | null {
  const index = stepIndex(step);
  return index > 0 ? WIZARD_STEPS[index - 1].id : null;
}

export function wizardHref(productId: string, step: WizardStep): string {
  return `/admin/products/${productId}/wizard?step=${step}`;
}
