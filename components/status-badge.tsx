type Tone = "preorder" | "positive" | "negative" | "neutral";

/**
 * Square-cornered, outlined badges — not solid pills. Every badge carries a
 * text label, so status never depends on color alone.
 */
const tones: Record<Tone, string> = {
  preorder: "border-brass text-brass",
  positive: "border-transit-green text-transit-green",
  negative: "border-stamp-red text-stamp-red",
  neutral: "border-blue-300 text-blue-600",
};

export function StatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-card border px-2 py-1 text-meta ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
