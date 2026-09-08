/**
 * Generated artwork for a product with no photograph yet.
 *
 * An empty pale rectangle reading "no photo" is the single thing that makes a
 * young catalogue look abandoned. This draws something deliberate instead,
 * derived from the product's own slug — so the artwork is stable for a given
 * product and two products rarely collide.
 *
 * Inline SVG: no request, no layout shift, nothing to host, and it stays crisp
 * at any size. It is a stand-in for real photography, never a replacement —
 * wherever a real image exists, the image wins.
 */

/** Deterministic, so artwork does not change between renders or machines. */
function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return Math.abs(result);
}

/**
 * Drawn from the palette, deliberately narrow. The shop should look like one
 * shop across a whole grid of these, not like a paint catalogue.
 */
const SCHEMES = [
  { base: "#12233f", tint: "#2563eb" },
  { base: "#0f2a4a", tint: "#4c8dff" },
  { base: "#12233f", tint: "#1e7a50" },
  { base: "#152a52", tint: "#2fa36e" },
  { base: "#1a2c50", tint: "#2563eb" },
] as const;

function initials(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function ProductArt({
  title,
  seed,
  className = "",
}: {
  title: string;
  /** Usually the slug: stable, unique, already at hand. */
  seed: string;
  className?: string;
}) {
  const value = hash(seed);
  const scheme = SCHEMES[value % SCHEMES.length];
  const id = `art-${value.toString(36)}`;

  // Three bands of differing width, offset by the seed: the same ruled-form
  // language as the rest of the site, arranged differently each time.
  const offset = value % 120;

  return (
    <svg
      viewBox="0 0 400 400"
      className={className}
      role="img"
      aria-label={`Placeholder artwork for ${title}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={scheme.base} />
          <stop offset="100%" stopColor={scheme.tint} stopOpacity="0.55" />
        </linearGradient>

        <clipPath id={`${id}-clip`}>
          <rect width="400" height="400" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${id}-clip)`}>
        <rect width="400" height="400" fill={`url(#${id}-bg)`} />

        {/* Diagonal rules, the manifest ruling seen at an angle. */}
        <g
          transform={`translate(${offset - 60} 0) rotate(20 200 200)`}
          stroke="#ffffff"
          strokeOpacity="0.10"
          strokeWidth="1"
        >
          {Array.from({ length: 14 }, (_, line) => (
            <line
              key={line}
              x1={line * 36}
              y1="-80"
              x2={line * 36}
              y2="480"
            />
          ))}
        </g>

        {/* One heavier band, brass, the way a customs stamp crosses a form. */}
        <rect
          x="-40"
          y={120 + (value % 60)}
          width="480"
          height="14"
          fill="#f0a631"
          fillOpacity="0.85"
          transform="rotate(-8 200 200)"
        />

        <text
          x="200"
          y="238"
          textAnchor="middle"
          fontFamily="Georgia, 'Times New Roman', serif"
          fontSize="96"
          letterSpacing="4"
          fill="#ffffff"
          fillOpacity="0.92"
        >
          {initials(title)}
        </text>

        {/* Corner ticks, like a printed customs form. */}
        {[
          [18, 18, 1, 1],
          [382, 18, -1, 1],
          [18, 382, 1, -1],
          [382, 382, -1, -1],
        ].map(([x, y, dx, dy]) => (
          <path
            key={`${x}-${y}`}
            d={`M${x} ${y + 24 * dy}V${y}H${x + 24 * dx}`}
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.45"
            strokeWidth="2"
          />
        ))}
      </g>
    </svg>
  );
}
