const steps = [
  {
    label: "Window open",
    title: "Order while the window is open",
    body: "Each listing states how long is left and how many places remain in the batch. Both are read from the batch itself, not estimated.",
  },
  {
    label: "Sourced",
    title: "We buy the batch in the United States",
    body: "When the window shuts we place one order for everyone in it. Nothing is bought before that, which is what keeps the price where it is.",
  },
  {
    label: "Landed",
    title: "It clears customs and reaches your door",
    body: "Duty and freight are already inside the price you paid. There is nothing to settle with the courier when it arrives.",
  },
];

/**
 * The one dark band on the page.
 *
 * It exists to break the run of pale sections and to give the page a spine —
 * and the spine is literal: a rule that draws itself down the section as you
 * scroll through it, so the three steps read as one journey rather than three
 * unrelated boxes.
 *
 * The rule is drawn by a CSS scroll timeline rather than a motion hook, which
 * is the right tool twice over. A progress line *should* scrub — running
 * backwards as you scroll back up is exactly what a progress line means, which
 * is the opposite of an entrance, where it is a bug. And it takes no
 * JavaScript: this section is on the home page, which was measured at 192KB
 * gzipped against a 200KB budget, and a scroll-linked spring is an expensive
 * way to move one rule. Where the browser cannot drive it, the rule is simply
 * drawn in full, which is a complete and correct picture of the journey.
 */
export function ProcessBand() {
  return (
    <section className="surface-ink relative overflow-hidden text-paper">
      <div
        aria-hidden="true"
        className="grid-rule pointer-events-none absolute inset-0 text-paper opacity-[0.08]"
      />

      <div className="relative mx-auto w-full max-w-[1280px] px-4 py-16 md:px-6 md:py-24">
        <div className="max-w-[46ch]">
          <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass">
            <span aria-hidden="true" className="h-px w-8 bg-brass" />
            How a batch works
          </p>
          <h2 className="mt-3 font-display text-[clamp(1.75rem,4vw,2.75rem)] leading-[1.15] text-paper">
            Buying something before it exists here
          </h2>
          <p className="mt-4 text-body text-paper/75">
            These goods are not in Bangladesh yet. That is the whole point, and
            it is why the sequence below is worth reading once.
          </p>
        </div>

        <ol className="relative mt-12 flex flex-col gap-10 pl-10 md:gap-14 md:pl-14">
          {/* The track, and the part of it that has been drawn. */}
          <span
            aria-hidden="true"
            className="absolute left-[15px] top-2 h-[calc(100%-1rem)] w-px bg-paper/20 md:left-[23px]"
          />
          <span
            aria-hidden="true"
            className="process-rule absolute left-[15px] top-2 h-[calc(100%-1rem)] w-px bg-brass md:left-[23px]"
          />

          {steps.map((step, index) => (
            <li key={step.title} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-10 top-0 inline-flex size-8 items-center justify-center rounded-full border border-brass/60 bg-ink-deep font-display text-meta tabular-nums text-brass md:-left-14 md:size-12"
              >
                {String(index + 1).padStart(2, "0")}
              </span>

              <p className="text-meta uppercase tracking-[0.18em] text-paper/50">
                {step.label}
              </p>
              <h3 className="mt-1.5 max-w-[24ch] font-display text-h2 text-paper">
                {step.title}
              </h3>
              <p className="mt-2 max-w-[52ch] text-body text-paper/70">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
