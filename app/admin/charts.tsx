/**
 * The admin's charts: one measure per chart, drawn as plain SVG on the server.
 *
 * Single series only, so there is no legend — the chart's heading names what
 * it shows — and never two scales on one chart (a sales chart and an orders
 * chart are two charts). Bars are thin with a rounded data end anchored to the
 * baseline, the grid is one recessive line, and every bar carries its exact
 * value as a hover tooltip plus a screen-reader table of the same numbers.
 */

export type BarPoint = {
  /** Axis label, e.g. "3 Sep". */
  label: string;
  value: number;
  /** The value as a person reads it, e.g. "৳12,400". */
  display: string;
};

export function BarChart({
  points,
  title,
  height = 132,
  emptyText = "Nothing in this period.",
}: {
  points: BarPoint[];
  /** Used for the accessible name and the table caption. */
  title: string;
  height?: number;
  emptyText?: string;
}) {
  const peak = Math.max(0, ...points.map((point) => point.value));

  if (points.length === 0 || peak === 0) {
    return (
      <p className="flex items-center justify-center rounded-control bg-blue-50/60 text-meta text-ink/70" style={{ height }}>
        {emptyText}
      </p>
    );
  }

  const width = 600;
  const plotHeight = height - 18;
  const slot = width / points.length;
  const barWidth = Math.max(2, Math.min(22, slot - 2));
  // Label only a handful of days, spaced evenly, so they never collide.
  const labelEvery = Math.max(1, Math.ceil(points.length / 7));
  const peakIndex = points.findIndex((point) => point.value === peak);

  return (
    <figure className="relative m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}. Highest: ${points[peakIndex].display} on ${points[peakIndex].label}.`}
        className="block h-auto w-full overflow-visible"
        style={{ height }}
      >
        <line
          x1={0}
          x2={width}
          y1={plotHeight + 0.5}
          y2={plotHeight + 0.5}
          stroke="var(--color-blue-200)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {points.map((point, index) => {
          const barHeight = point.value === 0 ? 0 : Math.max(2, (point.value / peak) * (plotHeight - 6));
          const x = index * slot + (slot - barWidth) / 2;
          const y = plotHeight - barHeight;
          return (
            <g key={`${point.label}-${index}`} className="group">
              {/* The hit target is the whole column, wider than the bar. */}
              <rect x={index * slot} y={0} width={slot} height={plotHeight} fill="transparent">
                <title>{`${point.label}: ${point.display}`}</title>
              </rect>
              {barHeight > 0 ? (
                <path
                  d={roundedTop(x, y, barWidth, barHeight, Math.min(4, barWidth / 2))}
                  className="pointer-events-none fill-blue-600 transition-opacity group-hover:opacity-70"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[0.6875rem] tabular-nums text-ink/70" aria-hidden="true">
        {points
          .filter((_, index) => index % labelEvery === 0 || index === points.length - 1)
          .map((point, index) => (
            <span key={`${point.label}-${index}`}>{point.label}</span>
          ))}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {points.map((point, index) => (
            <tr key={`${point.label}-${index}`}>
              <th scope="row">{point.label}</th>
              <td>{point.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h);
  return [
    `M${x},${y + h}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + w - radius}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `V${y + h}`,
    "Z",
  ].join(" ");
}

/**
 * A horizontal share bar for ranked lists (top products, categories). The
 * figure itself is printed beside it, so the bar only carries proportion.
 */
export function ShareBar({ share }: { share: number }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-blue-100" aria-hidden="true">
      <span
        className="block h-full rounded-full bg-blue-600"
        style={{ width: `${Math.max(2, Math.round(Math.min(1, share) * 100))}%` }}
      />
    </span>
  );
}

/** "+12%" / "−4%" against the previous period, or nothing to compare with. */
export function Delta({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) {
    return current > 0 ? <span className="text-[0.6875rem] text-ink/70">new this period</span> : null;
  }
  const change = (current - previous) / previous;
  const rounded = Math.round(change * 100);
  if (rounded === 0) return <span className="text-[0.6875rem] text-ink/70">same as before</span>;
  const up = rounded > 0;
  return (
    <span className={`text-[0.6875rem] font-semibold ${up ? "text-transit-green-text" : "text-stamp-red-text"}`}>
      {up ? "▲" : "▼"} {Math.abs(rounded)}%
      <span className="font-normal text-ink/70"> vs previous</span>
    </span>
  );
}

export function shortDay(isoDay: string): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
