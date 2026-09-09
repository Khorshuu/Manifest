import { formatShortDate } from "@/lib/format";

/**
 * The transit line: a horizontal dotted line with square, stamp-style
 * checkpoints — a manifest, not a generic rounded progress bar
 * (docs/DESIGN_GUIDELINES.md).
 *
 * Every checkpoint carries its own text label, so progress never depends on
 * colour or shape alone.
 */

const PIPELINE = [
  { status: "placed", label: "Placed" },
  { status: "payment_confirmed", label: "Payment confirmed" },
  { status: "sourcing", label: "Sourcing in the US" },
  { status: "shipped_from_us", label: "Shipped from the US" },
  { status: "in_bd_customs", label: "In customs" },
  { status: "out_for_delivery", label: "Out for delivery" },
  { status: "delivered", label: "Delivered" },
] as const;

const TERMINAL_LABELS: Record<string, string> = {
  cancelled: "Cancelled",
  refunded: "Refunded",
};

export type ProgressEntry = { status: string; createdAt: Date };

export function OrderProgress({
  status,
  history = [],
}: {
  status: string;
  history?: ProgressEntry[];
}) {
  // Cancelled and refunded leave the pipeline rather than sitting inside it.
  if (status in TERMINAL_LABELS) {
    return (
      <div className="rounded-card border border-stamp-red bg-stamp-red/5 p-4">
        <p className="text-meta text-stamp-red-text">{TERMINAL_LABELS[status]}</p>
        <p className="mt-1 text-body text-ink">
          This order is no longer in progress.
        </p>
      </div>
    );
  }

  const currentIndex = PIPELINE.findIndex((step) => step.status === status);
  const reachedAt = new Map(
    history.map((entry) => [entry.status, entry.createdAt]),
  );

  return (
    <ol className="flex flex-wrap gap-y-6">
      {PIPELINE.map((step, index) => {
        const passed = index <= currentIndex;
        const date = reachedAt.get(step.status);

        return (
          <li
            key={step.status}
            className="flex min-w-[120px] flex-1 flex-col gap-2"
          >
            <div className="flex items-center gap-0">
              {/* Square checkpoint: filled once passed, hollow before. */}
              <span
                aria-hidden="true"
                className={`size-3 shrink-0 rounded-none border ${
                  passed
                    ? "border-transit-green bg-transit-green"
                    : "border-blue-400 bg-transparent"
                }`}
              />
              {index < PIPELINE.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={`h-px flex-1 ${
                    index < currentIndex
                      ? "bg-transit-green"
                      : "border-t border-dotted border-blue-400"
                  }`}
                />
              ) : null}
            </div>

            <div className="pr-3">
              <p
                className={`text-meta ${passed ? "text-ink" : "text-ink/70"}`}
              >
                {step.label}
              </p>
              {date ? (
                <p className="text-meta text-ink/70">
                  {formatShortDate(date)}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
