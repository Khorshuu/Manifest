# Archived hero: the departure board

The hero background in place for commit `58e175b` only. A wall of sixteen
columns of flaps that step over and settle, lit from the left, with a brass
arrival line crossing it on a long cycle. No JavaScript in it at all.

Replaced by the campaign-banner hero. Kept here because it is a complete,
working idea and the choice between the two is a matter of taste rather than
correctness.

Nothing here is compiled or linted: the code is fenced, not sourced.

## To restore it

1. Copy the first block back to `components/hero-backdrop.tsx`.
2. Paste the second block into `app/globals.css`.
3. Render `<HeroBackdrop />` as the first child of the hero `<section>`, and
   put the dark ground back on that section (`bg-ink-deep text-paper`).

Or take the whole hero back exactly as it was:

```
git checkout 58e175b -- components/hero-backdrop.tsx components/hero-carousel.tsx app/globals.css
```

## components/hero-backdrop.tsx

```tsx
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
```

## The board rules from app/globals.css

```css
/*
 * The hero backdrop: the departure board.
 *
 * See components/hero-backdrop.tsx for why this is columns rather than tiles,
 * and why the timing is stepped. The short version: a wall of two hundred
 * flaps costs sixteen animated elements, and `steps()` is what makes the
 * movement read as mechanical rather than as something sliding past.
 */
.hero-board {
  /* The face of a flap, and the shadow in the seam between two of them. */
  /*
   * Presence is the whole point.
   *
   * The first pass of these values was measured to look tasteful and read as
   * nothing — a faint horizontal banding behind a heavy scrim. Two earlier
   * hero backgrounds were rejected for exactly that, so the faces here are
   * deliberately strong enough to be seen as objects, and the scrim over them
   * is doing the work of protecting the headline instead of hiding the board.
   */
  --flap-face: rgb(214 230 255 / 0.13);
  --flap-edge: rgb(255 255 255 / 0.34);
  --flap-under: rgb(255 255 255 / 0.05);
  --flap-gap: rgb(4 10 22 / 0.9);
  --flap-height: 46px;
}

.hero-board__wall {
  position: absolute;
  /* Overscans the panel so no column ever shows its own top or bottom edge. */
  inset: -12% -2%;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 5px;
}

/*
 * One column of flaps, drawn as a repeating gradient rather than as elements.
 *
 * Each repeat is one flap: a lit top half, a darker bottom half, a bright
 * hairline where the two faces meet, and a gap of ground between this flap and
 * the next.
 */
.hero-board__column {
  background-image: repeating-linear-gradient(
    180deg,
    var(--flap-face) 0,
    var(--flap-face) calc(var(--flap-height) * 0.45),
    var(--flap-edge) calc(var(--flap-height) * 0.45),
    var(--flap-edge) calc(var(--flap-height) * 0.5),
    var(--flap-under) calc(var(--flap-height) * 0.5),
    var(--flap-under) calc(var(--flap-height) * 0.9),
    var(--flap-gap) calc(var(--flap-height) * 0.9),
    var(--flap-gap) var(--flap-height)
  );
  /* The animation moves the column by exactly one flap at a time, so it always
     comes to rest with the faces aligned. */
  animation-name: hero-board-step;
  animation-iteration-count: infinite;
  animation-timing-function: steps(1, end);
  will-change: transform;
}

@keyframes hero-board-step {
  0%,
  22% {
    transform: translate3d(0, 0, 0);
  }
  25%,
  47% {
    transform: translate3d(0, calc(var(--flap-height) * -1), 0);
  }
  50%,
  72% {
    transform: translate3d(0, calc(var(--flap-height) * -2), 0);
  }
  75%,
  97% {
    transform: translate3d(0, calc(var(--flap-height) * -3), 0);
  }
  100% {
    transform: translate3d(0, calc(var(--flap-height) * -4), 0);
  }
}

/* The hall light: strong at the left, where the headline sits, falling away
   across the board so the right-hand side keeps its structure. */
.hero-board__light {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(
      70% 110% at 4% 46%,
      rgb(37 99 235 / 0.4) 0%,
      transparent 60%
    ),
    radial-gradient(
      55% 80% at 92% 4%,
      rgb(240 166 49 / 0.2) 0%,
      transparent 62%
    );
}

/*
 * An arrival crossing the board.
 *
 * One brass line, travelling down the whole panel on a long cycle — the moment
 * a row on a real board turns over. It is the only warm, moving thing here, so
 * it carries the eye without competing with the headline.
 */
.hero-board__arrival {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 2px;
  /* Weighted to the right of the panel, where the board is, so it never draws
     a line through the headline — which is what it looked like when it ran the
     full width: an accident rather than a row turning over. */
  background: linear-gradient(
    90deg,
    transparent 0%,
    transparent 38%,
    rgb(240 166 49 / 0.5) 56%,
    rgb(240 166 49 / 0.95) 74%,
    rgb(240 166 49 / 0.5) 92%,
    transparent 100%
  );
  box-shadow: 0 0 18px 2px rgb(240 166 49 / 0.28);
  animation: hero-board-arrival 9s cubic-bezier(0.5, 0, 0.2, 1) infinite;
}

@keyframes hero-board-arrival {
  0% {
    transform: translateY(-10%);
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  70% {
    opacity: 1;
  }
  100% {
    transform: translateY(calc(100vh + 10%));
    opacity: 0;
  }
}

/* A smaller flap on a phone, so the board still reads as a board rather than
   as four enormous bars. */
@media (max-width: 640px) {
  .hero-board {
    --flap-height: 26px;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* The board stands still and lit, which is a complete picture of it rather
     than a broken one. */
  .hero-board__column,
  .hero-board__arrival {
    animation: none;
  }

  .hero-board__arrival {
    opacity: 0.55;
    transform: translateY(38vh);
  }
}
```
