/**
 * The hero backdrop: a departure board, at the scale of the panel.
 *
 * Two earlier attempts were rejected and both failed the same way — they were
 * *ambient*. A still ruled grid, then a field of faint dots and arcs. The note
 * on the second one is the brief for this one: low-contrast drifting effects
 * read as noise, and subtlety is the failure mode here, not the goal.
 *
 * So this is not a texture. It is an object: the mechanical board that hangs
 * in a departures hall, built from columns of flaps that step over and settle.
 * It fits the shop exactly — every listing here is a batch with a departure and
 * an arrival — and it is the same object the countdown already is, so the hero
 * and the clock beneath it are now one idea at two sizes.
 *
 * Three things make it cheap enough to run for the life of the page:
 *
 *   - Columns, not tiles. Each column is one element whose background is a
 *     repeating gradient of flap faces, so a wall of two hundred flaps costs
 *     sixteen animated nodes rather than two hundred.
 *   - `steps()` timing. The movement is discrete, which is what makes it read
 *     as mechanical rather than as something sliding. It is also the reason
 *     this works at low contrast where a smooth drift did not: the eye catches
 *     the change, not the tone.
 *   - No JavaScript at all. There are no hooks here, nothing measures, nothing
 *     runs per frame — the whole thing is CSS, so it costs the home page
 *     nothing against its 200KB budget.
 *
 * It stops entirely for anyone who has asked for reduced motion, where it
 * stands as a still board.
 */

/** Enough columns to read as a wall, few enough to stay cheap. */
const COLUMNS = 16;

export function HeroBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="hero-board pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div className="hero-board__wall">
        {Array.from({ length: COLUMNS }, (_, index) => (
          <span
            key={index}
            className="hero-board__column"
            style={{
              /*
               * Deterministic rather than random: the same board renders on the
               * server and the client, and the pattern still reads as
               * unsynchronised because the two figures share no common factor.
               */
              animationDelay: `${(index % 7) * 0.65 + (index % 3) * 0.22}s`,
              animationDuration: `${5.5 + (index % 5) * 1.35}s`,
            }}
          />
        ))}
      </div>

      {/* The board is lit from the left, the way a hall is. */}
      <div className="hero-board__light" />

      {/* An arrival crossing the board on a long cycle: the one warm moment. */}
      <div className="hero-board__arrival" />
    </div>
  );
}
