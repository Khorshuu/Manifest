import { Suspense } from "react";
import { researchSetup, type ResearchSetupItem } from "@/lib/preparation/setup";

/**
 * The optional services behind "Prepare with SeoPulse", and whether each is
 * set up and running (D-123, D-124). For the owner; it shows states, never
 * credentials.
 */
export function ResearchSetupList({ items, compact = false }: { items: ResearchSetupItem[]; compact?: boolean }) {
  return (
    <dl className={`grid gap-2 ${compact ? "" : "sm:grid-cols-2 lg:grid-cols-4"}`} data-research-setup>
      {items.map((item) => (
        <div
          key={item.key}
          data-setup={item.key}
          data-state={item.state}
          className={`rounded-control border px-3 py-2 ${
            item.state === "configured"
              ? "border-blue-300 bg-blue-50/60"
              : item.state === "unavailable" || item.state === "missing_key"
                ? "border-brass bg-brass/5"
                : "border-line bg-paper"
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

async function LoadedResearchSetup({ compact }: { compact: boolean }) {
  return <ResearchSetupList items={await researchSetup()} compact={compact} />;
}

/**
 * The list with its local health checks, streamed: the checks are bounded
 * and cached, but the page around them never waits for them.
 */
export function ResearchSetup({ compact = false }: { compact?: boolean }) {
  return (
    <Suspense fallback={<p className="text-[0.75rem] text-ink/60">Checking research services…</p>}>
      <LoadedResearchSetup compact={compact} />
    </Suspense>
  );
}
