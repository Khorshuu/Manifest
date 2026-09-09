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
    <section className="mt-16 border-t border-ink/15 pt-10">
      <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
        <span aria-hidden="true" className="h-px w-8 bg-brass" />
        The route
      </p>
      <h2 className="mt-2 font-display text-h1 text-ink">
        How this one reaches you
      </h2>

      <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((stage, index) => (
          <li
            key={stage.title}
            className="lift flex flex-col gap-3 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)]"
          >
            <div className="flex items-center justify-between gap-3">
              <span
                aria-hidden="true"
                className="inline-flex size-10 items-center justify-center rounded-card border border-blue-300 bg-blue-50 text-blue-600"
              >
                <stage.icon size={20} />
              </span>
              <span
                aria-hidden="true"
                className="font-display text-h3 tabular-nums text-brass-text"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
            </div>

            <h3 className="font-display text-h3 text-ink">{stage.title}</h3>
            <p className="max-w-[36ch] text-meta text-ink/70">{stage.detail}</p>
          </li>
        ))}
      </ol>

      {/* The two dates a shopper actually needs, stated plainly underneath. */}
      <dl className="surface-paper mt-6 flex flex-wrap gap-x-12 gap-y-3 rounded-card border border-blue-300 px-5 py-4 text-body">
        {closesAt ? (
          <div>
            <dt className="text-meta text-ink/70">Ordering closes</dt>
            <dd className="text-ink">{formatShortDate(closesAt)}</dd>
          </div>
        ) : null}
        {arrivesFrom ? (
          <div>
            <dt className="text-meta text-ink/70">Expected with you</dt>
            <dd className="text-ink">
              {formatShortDate(arrivesFrom)}
              {arrivesTo ? ` to ${formatShortDate(arrivesTo)}` : ""}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-meta text-ink/70">To pay on delivery</dt>
          <dd className="text-ink">Nothing — duty and freight are in the price</dd>
        </div>
      </dl>
    </section>
  );
}
