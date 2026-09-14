import { IconCrate, IconPlane, IconSeal, IconTruck } from "./icons";
import { formatShortDate } from "@/lib/format";

/**
 * The route the goods take, drawn as the stages on a waybill.
 *
 * A preorder shopper is being asked to wait months for something that has not
 * been bought yet, so the single most useful thing a product page can do is
 * show them the whole journey at once — where it starts, what happens in the
 * middle, and roughly when it reaches them.
 *
 * The numbering is legitimate here: this genuinely is a sequence, in order,
 * and each stage happens after the one before it.
 *
 * On a phone the whole section fits one screen (owner's request): a smaller
 * heading, all four stages side by side as small cards carrying the icon,
 * number and title, and the dates in a tight block. The sentence under each
 * stage is left to the larger layouts, where there is room to read it.
 */

const STAGES = [
  {
    icon: IconCrate,
    title: "We buy it in the US",
    detail: "Once the window closes, we place the order with the retailer.",
  },
  {
    icon: IconPlane,
    title: "It flies to Dhaka",
    detail: "Consolidated with the rest of the batch and flown in.",
  },
  {
    icon: IconSeal,
    title: "Customs clears it",
    detail: "Duty is already paid in your price. Nothing to settle here.",
  },
  {
    icon: IconTruck,
    title: "A courier brings it",
    detail: "Delivered to the address you gave, with a tracking reference.",
  },
] as const;

export function Journey({
  closesAt,
  arrivesFrom,
  arrivesTo,
}: {
  closesAt: Date | null;
  arrivesFrom: Date | null;
  arrivesTo: Date | null;
}) {
  return (
    <section className="mt-10 border-t border-ink/15 pt-6 sm:mt-16 sm:pt-10">
      <p className="flex items-center gap-3 text-[0.6875rem] uppercase tracking-[0.18em] text-brass-text sm:text-meta">
        <span aria-hidden="true" className="h-px w-6 bg-brass sm:w-8" />
        The route
      </p>
      <h2 className="mt-1 font-display text-[1.25rem] leading-tight text-ink sm:mt-2 sm:text-h1">
        How this one reaches you
      </h2>

      <ol className="mt-4 grid grid-cols-4 gap-1.5 sm:mt-8 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        {STAGES.map((stage, index) => (
          <li
            key={stage.title}
            className="lift flex min-w-0 flex-col gap-1.5 rounded-control border border-blue-300 bg-paper p-2 shadow-[var(--shadow-raise)] sm:gap-3 sm:rounded-card sm:p-5"
          >
            <div className="flex items-center justify-between gap-1 sm:gap-3">
              <span
                aria-hidden="true"
                className="inline-flex size-7 items-center justify-center rounded-[8px] border border-blue-300 bg-blue-50 text-blue-600 sm:size-10 sm:rounded-card"
              >
                <stage.icon size={20} className="size-4 sm:size-5" />
              </span>
              <span
                aria-hidden="true"
                className="font-display text-[0.75rem] tabular-nums text-brass-text sm:text-h3"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
            </div>

            <h3 className="font-display text-[0.75rem] leading-snug text-ink [overflow-wrap:anywhere] sm:text-h3">
              {stage.title}
            </h3>
            <p className="hidden max-w-[36ch] text-meta text-ink/70 sm:block">
              {stage.detail}
            </p>
          </li>
        ))}
      </ol>

      {/* The two dates a shopper actually needs, stated plainly underneath. */}
      <dl className="surface-paper mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-control border border-blue-300 px-3 py-2.5 text-meta sm:mt-6 sm:flex sm:flex-wrap sm:gap-x-12 sm:gap-y-3 sm:rounded-card sm:px-5 sm:py-4 sm:text-body">
        {closesAt ? (
          <div>
            <dt className="text-[0.6875rem] text-ink/70 sm:text-meta">Ordering closes</dt>
            <dd className="text-ink">{formatShortDate(closesAt)}</dd>
          </div>
        ) : null}
        {arrivesFrom ? (
          <div>
            <dt className="text-[0.6875rem] text-ink/70 sm:text-meta">Expected with you</dt>
            <dd className="text-ink">
              {formatShortDate(arrivesFrom)}
              {arrivesTo ? ` to ${formatShortDate(arrivesTo)}` : ""}
            </dd>
          </div>
        ) : null}
        <div className="col-span-2">
          <dt className="text-[0.6875rem] text-ink/70 sm:text-meta">To pay on delivery</dt>
          <dd className="text-ink">Nothing — duty and freight are in the price</dd>
        </div>
      </dl>
    </section>
  );
}
