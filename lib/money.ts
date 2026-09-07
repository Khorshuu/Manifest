/**
 * Money is always integer minor units: BDT paisa for customer-facing amounts,
 * USD cents for sourcing cost. Never floats — see CLAUDE.md conventions.
 */

const bdtFormatter = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatBdt(paisa: number): string {
  if (!Number.isInteger(paisa)) {
    throw new Error(`BDT amount must be an integer in paisa, received ${paisa}`);
  }
  return bdtFormatter.format(paisa / 100);
}

export function taka(amount: number): number {
  return Math.round(amount * 100);
}
