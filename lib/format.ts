/**
 * Display formatting. Dates are written out — "Thursday, Feb 12" — never
 * numeric-only or relative, per docs/DESIGN_GUIDELINES.md.
 */
const DHAKA = "Asia/Dhaka";

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: DHAKA,
  }).format(date);
}

export function formatShortDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: DHAKA,
  }).format(date);
}

/** "Arrives 12 Feb – 26 Feb", or a single date when there is no range. */
export function formatArrivalWindow(
  from: Date | null,
  to: Date | null,
): string | null {
  if (!from && !to) return null;
  if (from && to) return `${formatShortDate(from)} – ${formatShortDate(to)}`;
  return formatShortDate((from ?? to)!);
}

/**
 * Whole days until a date, rounded up, floored at zero. Used only alongside a
 * written-out date, never as the only signal.
 */
export function daysUntil(date: Date, now: Date = new Date()): number {
  const ms = date.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
