# Archived hero: the drifting-orbs backdrop

The hero background in place from commit `b79387e` until `9b0fde2`, kept here
so it can be put back at any time. It is an oversized outlined `DHAKA`
wordmark, two blurred colour fields drifting against each other, a raking
light sweeping on a long cycle, and a dashed route line with an arrival
pulse — all of it moving against the pointer at different rates.

Nothing here is compiled or linted: the code is fenced, not sourced.

## To restore it

1. Copy the first block back to `components/hero-backdrop.tsx`.
2. Paste the second block into `app/globals.css`, replacing whatever hero
   background rules are there at the time.
3. In `components/hero-carousel.tsx`, render `<HeroBackdrop />` as the first
   child of the `<section>`.

Or take the whole hero back exactly as it was, in one command:

```
git checkout 9b0fde2 -- components/hero-backdrop.tsx components/hero-carousel.tsx app/globals.css
```

That last one also reverts anything else in `globals.css` that has changed
since, so prefer the three steps above unless you want the whole file back.

## components/hero-backdrop.tsx

```tsx
"use client";

import { useEffect, useRef } from "react";

/**
 * The hero backdrop: layered depth, not a particle field.
 *
 * The first attempt at this was a canvas of faint dotted arcs and travelling
 * dots. It was rejected, correctly — low-contrast ambient effects read as noise
 * rather than as spectacle, however neatly the metaphor fits the business.
 *
 * This follows the direction the design data actually gives for a hero
 * background: multi-layer parallax, "background slowest, foreground fastest",
 * with the scale coming from oversized typography rather than from small moving
 * particles. Four layers, each moving at a different rate against the pointer
 * and the scroll:
 *
 *   1. A vast outlined word, DHAKA — the destination, at display scale.
 *   2. Two colour fields, brass and blue, drifting slowly against each other.
 *   3. A raking light band that sweeps across on a long cycle.
 *   4. A route line with the origin and destination marked.
 *
 * Everything moves by `transform` on a composited layer, so none of it costs
 * layout, and all of it stops for `prefers-reduced-motion`.
 */
export function HeroBackdrop() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    // Where the pointer is heading, and where the layers have got to. Easing
    // one towards the other is what stops the parallax feeling twitchy.
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };

    function onPointerMove(event: PointerEvent) {
      const rect = root!.getBoundingClientRect();
      target.x = (event.clientX - rect.left) / rect.width - 0.5;
      target.y = (event.clientY - rect.top) / rect.height - 0.5;
    }

    function onLeave() {
      target.x = 0;
      target.y = 0;
    }

    function tick() {
      current.x += (target.x - current.x) * 0.06;
      current.y += (target.y - current.y) * 0.06;

      root!.style.setProperty("--px", current.x.toFixed(4));
      root!.style.setProperty("--py", current.y.toFixed(4));

      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);

    const parent = root.parentElement ?? root;
    parent.addEventListener("pointermove", onPointerMove);
    parent.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(frame);
      parent.removeEventListener("pointermove", onPointerMove);
      parent.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className="hero-backdrop pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* 2. Colour. Two large fields, drifting against each other. */}
      <div className="hero-orb hero-orb--brass" />
      <div className="hero-orb hero-orb--blue" />

      {/* 1. The destination, at the scale of the panel itself. */}
      <div className="hero-wordmark" data-depth="1">
        <span>DHAKA</span>
      </div>

      {/* 4. The route it travels, drawn once rather than animated per-particle. */}
      <svg
        className="hero-route"
        data-depth="3"
        viewBox="0 0 1200 600"
        preserveAspectRatio="xMidYMid slice"
      >
        <path
          d="M -60 470 C 240 300, 520 250, 760 230"
          fill="none"
          stroke="rgba(240,166,49,0.55)"
          strokeWidth="2"
          strokeDasharray="10 12"
          className="hero-route__line"
        />
        <circle cx="-40" cy="465" r="7" fill="rgba(138,180,255,0.9)" />
        <circle cx="760" cy="230" r="9" fill="rgba(240,166,49,0.95)" />
        <circle
          cx="760"
          cy="230"
          r="9"
          fill="none"
          stroke="rgba(240,166,49,0.7)"
          strokeWidth="2"
          className="hero-route__pulse"
        />
      </svg>

      {/* 3. A raking light, crossing on a long cycle. */}
      <div className="hero-sweep" data-depth="2" />
    </div>
  );
}
```

## The hero rules from app/globals.css

```css
/*
 * The hero backdrop.
 *
 * Layered depth rather than a particle field: an oversized wordmark, two colour
 * fields, a raking light and the route, each moving at a different rate against
 * the pointer. `--px` and `--py` are written by components/hero-backdrop.tsx on
 * an animation frame; every layer reads them at its own multiplier, which is
 * what the design data means by "background slowest, foreground fastest".
 */
.hero-backdrop {
  --px: 0;
  --py: 0;
}

.hero-backdrop [data-depth] {
  will-change: transform;
}

/* The destination, at the scale of the panel. */
.hero-wordmark {
  position: absolute;
  /*
   * Centred across the foot of the panel rather than bleeding off the left
   * edge. Anchored left, the leading letters ran off screen and the word read
   * as a smear of unrelated letterforms sitting directly behind the two
   * buttons — the busiest part of the hero. Whole and centred, it is legibly
   * the destination and it sits under the content rather than through it.
   */
  inset-inline: 0;
  text-align: center;
  bottom: -9%;
  transform: translate3d(calc(var(--px) * 22px), calc(var(--py) * 14px), 0);
  font-family: var(--font-display);
  font-size: clamp(5rem, 15vw, 15rem);
  font-weight: 600;
  line-height: 0.78;
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: transparent;
  /* Faint enough to read as ground rather than as a second headline: the
     content sits over the lower half of it, and at any heavier weight the
     letterforms compete with the buttons they run behind. */
  -webkit-text-stroke: 1.5px rgb(255 255 255 / 0.1);
  user-select: none;
}

/* A second pass in solid, clipped to a gradient, so the word is not a flat
   outline: it catches the light on one side. */
.hero-wordmark span {
  background: linear-gradient(
    100deg,
    rgb(255 255 255 / 0.08) 0%,
    rgb(240 166 49 / 0.14) 42%,
    transparent 72%
  );
  -webkit-background-clip: text;
  background-clip: text;
}

.hero-orb {
  position: absolute;
  border-radius: 9999px;
  filter: blur(64px);
  opacity: 0.9;
}

.hero-orb--brass {
  width: 46vw;
  height: 46vw;
  max-width: 620px;
  max-height: 620px;
  left: 30%;
  top: -18%;
  background: radial-gradient(
    circle,
    rgb(240 166 49 / 0.5) 0%,
    rgb(240 166 49 / 0) 68%
  );
  transform: translate3d(calc(var(--px) * 44px), calc(var(--py) * 26px), 0);
  animation: hero-drift-a 22s ease-in-out infinite alternate;
}

.hero-orb--blue {
  width: 54vw;
  height: 54vw;
  max-width: 760px;
  max-height: 760px;
  left: -14%;
  bottom: -26%;
  background: radial-gradient(
    circle,
    rgb(76 141 255 / 0.55) 0%,
    rgb(76 141 255 / 0) 66%
  );
  transform: translate3d(calc(var(--px) * 30px), calc(var(--py) * 18px), 0);
  animation: hero-drift-b 28s ease-in-out infinite alternate;
}

@keyframes hero-drift-a {
  to {
    translate: 6% 8%;
  }
}

@keyframes hero-drift-b {
  to {
    translate: -7% -5%;
  }
}

/* The route, and the arrival pulsing at the end of it. */
.hero-route {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: translate3d(calc(var(--px) * -34px), calc(var(--py) * -20px), 0);
}

.hero-route__line {
  stroke-dashoffset: 0;
  animation: hero-route-run 3.2s linear infinite;
}

@keyframes hero-route-run {
  to {
    stroke-dashoffset: -44;
  }
}

.hero-route__pulse {
  transform-origin: 760px 230px;
  animation: hero-arrive 2.8s ease-out infinite;
}

@keyframes hero-arrive {
  0% {
    transform: scale(1);
    opacity: 0.8;
  }
  70%,
  100% {
    transform: scale(5.5);
    opacity: 0;
  }
}

/* A raking light, crossing on a long cycle. */
.hero-sweep {
  position: absolute;
  inset: -30% -60%;
  background: linear-gradient(
    104deg,
    transparent 38%,
    rgb(255 255 255 / 0.055) 47%,
    rgb(240 166 49 / 0.05) 51%,
    transparent 60%
  );
  animation: hero-sweep-cross 13s ease-in-out infinite;
}

@keyframes hero-sweep-cross {
  0%,
  100% {
    transform: translate3d(-22%, 0, 0);
  }
  50% {
    transform: translate3d(22%, 0, 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-orb,
  .hero-sweep,
  .hero-route__line,
  .hero-route__pulse {
    animation: none;
  }

  .hero-wordmark,
  .hero-orb,
  .hero-route {
    transform: none;
  }
}
```
