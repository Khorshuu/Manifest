type Tone = "preorder" | "positive" | "negative" | "warning" | "neutral";

/**
 * Square-cornered, outlined badges — not solid pills. Every badge carries a
 * text label, so status never depends on color alone.
 */
const tones: Record<Tone, string> = {
  preorder: "border-brass text-brass-text",
  positive: "border-transit-green text-transit-green-text",
  negative: "border-stamp-red text-stamp-red-text",
  /** Something a shopper should notice but that is not a refusal — low stock. */
  warning: "border-brass bg-brass/10 text-brass-text",
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
