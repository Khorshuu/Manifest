import type { ResearchSetupItem } from "@/lib/preparation/setup";

/**
 * The three optional services behind "Prepare with SeoPulse", and whether each
 * is set up (D-123). For the owner; it shows states, never credentials.
 */
export function ResearchSetupList({ items, compact = false }: { items: ResearchSetupItem[]; compact?: boolean }) {
  return (
    <dl className={`grid gap-2 ${compact ? "" : "sm:grid-cols-3"}`} data-research-setup>
      {items.map((item) => (
        <div
          key={item.key}
          data-setup={item.key}
          data-state={item.state}
          className={`rounded-control border px-3 py-2 ${
            item.state === "configured" ? "border-blue-300 bg-blue-50/60" : "border-line bg-paper"
          }`}
        >
          <dt className="text-[0.75rem] font-medium text-ink/70">{item.label}</dt>
          <dd className="text-[0.8125rem] font-semibold text-ink">{item.status}</dd>
          {compact ? null : <dd className="mt-1 text-[0.75rem] text-ink/65">{item.detail}</dd>}
        </div>
      ))}
    </dl>
  );
}
