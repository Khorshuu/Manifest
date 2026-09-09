/**
 * How full a batch is.
 *
 * The bar is the fast read and the sentence underneath is the real one — the
 * colour is never the only thing carrying the meaning, because a shopper who
 * cannot distinguish the fill from the track still has to be able to tell a
 * batch that is nearly gone from one that has just opened.
 *
 * The fill is set to its true width in the markup and only *scaled* by the
 * animation. That ordering matters: a bar that animates its width from zero
 * shows an empty batch to anyone whose browser never runs the animation, which
 * would be a wrong number rather than a missing effect.
 *
 * Fills use the darker partners of the palette rather than the vivid ones, so
 * the bar stays legible against the pale track (DESIGN_GUIDELINES.md, and the
 * contrast pass recorded in docs/PROGRESS.md).
 */

export type CapacityTone = "light" | "dark";

function fillFor(fraction: number, dark: boolean) {
  if (fraction >= 0.85) {
    return dark ? "bg-stamp-red" : "bg-stamp-red-text";
  }
  if (fraction >= 0.6) {
    return dark ? "bg-brass" : "bg-brass-text";
  }
  return dark ? "bg-transit-green" : "bg-transit-green-text";
}

export function CapacityMeter({
  remaining,
  total,
  tone = "light",
  showLabel = true,
}: {
  remaining: number | null;
  total: number | null;
  tone?: CapacityTone;
  showLabel?: boolean;
}) {
  // Nothing capped means nothing to meter. An uncapped batch is not "empty",
  // it simply has no ceiling, and a bar at zero would say the opposite.
  if (remaining === null || total === null || total <= 0) return null;

  const taken = Math.max(0, Math.min(total, total - remaining));
  const fraction = taken / total;
  const percent = Math.round(fraction * 100);
  const dark = tone === "dark";

  const label =
    remaining <= 0
      ? `This batch is full — all ${total} places taken`
      : `${taken} of ${total} places taken, ${remaining} left`;

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label="Places taken in this batch"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={taken}
        aria-valuetext={label}
        className={`h-1.5 w-full overflow-hidden rounded-card ${
          dark ? "bg-paper/25" : "bg-blue-200"
        }`}
      >
        <div
          className={`meter-fill h-full rounded-card ${fillFor(fraction, dark)}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {showLabel ? (
        <p
          className={`text-meta tabular-nums ${
            dark ? "text-paper/70" : "text-ink/70"
          }`}
        >
          {remaining <= 0 ? (
            "Batch full"
          ) : (
            <>
              <span className={dark ? "text-paper" : "text-ink"}>
                {remaining}
              </span>{" "}
              of {total} places left
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
