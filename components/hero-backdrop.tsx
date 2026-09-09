/**
 * The ground under the campaign banner.
 *
 * The hero is light now, so this is a studio sweep rather than a dark panel:
 * a broad wash of daylight with the brand blue coming up from the lower left
 * and a warm brass bloom behind the product on the right, so the photograph
 * sits in light rather than on a flat colour.
 *
 * Over it, a very faint ruled field — the printed-form motif the rest of the
 * site is built on, at a size where it reads as paper texture rather than as a
 * grid. It is the one place a graph-paper rule belongs: behind a photograph,
 * on paper, at low contrast. Everywhere it was tried as the *subject* of a
 * hero it failed, and the two archived heroes in `docs/archive` are the record
 * of that.
 *
 * There are no hooks here and nothing runs per frame. The whole thing is two
 * gradients and one drifting bloom, so it costs the home page nothing against
 * its JavaScript budget.
 */
export function HeroBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="hero-banner pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div className="hero-banner__wash" />
      <div className="hero-banner__rule" />
      <div className="hero-banner__bloom" />
    </div>
  );
}
