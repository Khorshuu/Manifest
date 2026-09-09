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
