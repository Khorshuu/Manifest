const phases = [
  { id: "01", label: "Project scaffold & architecture", state: "done" },
  { id: "02", label: "Database schema & migrations", state: "next" },
  { id: "03", label: "Auth & admin shell", state: "pending" },
  { id: "04", label: "Product system", state: "pending" },
  { id: "05", label: "Variation engine", state: "pending" },
  { id: "06", label: "Inventory & preorder engine", state: "pending" },
] as const;

const stateStyles = {
  done: "border-transit-green text-transit-green",
  next: "border-brass text-brass",
  pending: "border-blue-300 text-blue-400",
} as const;

const stateLabels = {
  done: "Complete",
  next: "Next",
  pending: "Not started",
} as const;

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <p className="text-meta text-blue-400">Build status</p>
      <h1 className="mt-3 font-display text-h1 text-ink">
        Preorder storefront — scaffold in place
      </h1>
      <p className="mt-4 max-w-[70ch] text-body text-ink/80">
        Phase 1 is complete: Next.js, TypeScript, Tailwind wired to the Import
        Manifest design tokens, Drizzle and Postgres connected, and the lint,
        typecheck, unit test, and end-to-end test tooling all runnable. This
        placeholder is replaced by the real storefront in Phase 7.
      </p>

      <ol className="mt-10 border-t border-blue-300">
        {phases.map((phase) => (
          <li
            key={phase.id}
            className="flex items-center gap-4 border-b border-blue-300 py-4"
          >
            <span className="font-display text-h3 text-blue-400 tabular-nums">
              {phase.id}
            </span>
            <span className="flex-1 text-body text-ink">{phase.label}</span>
            <span
              className={`rounded-card border px-2 py-1 text-meta ${stateStyles[phase.state]}`}
            >
              {stateLabels[phase.state]}
            </span>
          </li>
        ))}
      </ol>
    </main>
  );
}
