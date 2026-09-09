"use client";

import { useEffect, useRef } from "react";

/**
 * The living ground behind the hero: goods crossing the ocean.
 *
 * The hero used to sit on a still printed-form grid. It matched the identity
 * and it did not hold anybody's attention, which is the only thing a hero has
 * to do. This replaces it with the journey the business actually performs —
 * shipments leaving the United States, arcing across, and landing in Dhaka,
 * over and over.
 *
 * Motion that means something, rather than shapes drifting: every element here
 * is a parcel on a route, and the pulse at the right-hand side is one arriving.
 *
 * Written by hand on a canvas rather than with a library, for three reasons.
 * The home page measured 181KB gzipped against a 200KB budget, so there is no
 * room for a WebGL dependency. One canvas costs a single element rather than
 * dozens of animated DOM nodes. And the whole thing stops dead — no timer, no
 * frame — when it is off screen, when the tab is hidden, or when the visitor
 * has asked their system to reduce motion.
 */

/** Brand colours, written out: canvas cannot read a CSS custom property. */
const BRASS = "240, 166, 49";
const SKY = "138, 180, 255";
const PAPER = "255, 255, 255";

type Shipment = {
  /** Position along its lane, 0 at the coast it leaves, 1 where it lands. */
  progress: number;
  speed: number;
  lane: number;
  /** Counts down after arrival, drawing the landing pulse. */
  landing: number;
};

type Waypoint = {
  x: number;
  y: number;
  radius: number;
  phase: number;
  speed: number;
};

/**
 * Five routes across the panel, at different heights and depths.
 *
 * `alpha` is a depth cue rather than a style choice: the nearer lanes are
 * brighter and move faster, which is what stops the field reading as a flat
 * pattern.
 */
const LANES = [
  { start: -0.15, end: 0, lift: 0.1, y: 0.42, alpha: 0.55 },
  { start: -0.22, end: 0, lift: 0.24, y: 0.68, alpha: 0.9 },
  { start: -0.1, end: 0, lift: 0.05, y: 0.9, alpha: 1 },
  { start: 1.2, end: 0, lift: 0.3, y: 0.5, alpha: 0.75 },
  { start: 1.15, end: 0, lift: 0.16, y: 0.86, alpha: 0.45 },
];

/**
 * Where the routes converge, as a fraction of the panel.
 *
 * Not the right-hand edge: on a wide screen the product plate covers roughly
 * the right half, so arrivals drawn out there happen behind it and the one
 * moment worth watching is the one nobody sees. They land just short of it
 * instead, in open space beside the headline.
 */
const DESTINATION = { x: 0.42, y: 0.13 };

/** A point on a lane's quadratic arc, in canvas pixels. */
function pointOn(
  lane: (typeof LANES)[number],
  t: number,
  width: number,
  height: number,
) {
  const x0 = lane.start * width;
  const y0 = lane.y * height;
  // Every route ends at the same place: this is one destination, not five.
  const x1 = DESTINATION.x * width;
  const y1 = DESTINATION.y * height;
  const cx = (x0 + x1) / 2;
  const cy = Math.min(y0, y1) - lane.lift * height;

  const inverse = 1 - t;
  return {
    x: inverse * inverse * x0 + 2 * inverse * t * cx + t * t * x1,
    y: inverse * inverse * y0 + 2 * inverse * t * cy + t * t * y1,
  };
}

export function HeroFlightPath() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Where the pointer is, 0 to 1 across the panel, for the parallax. */
  const pointerRef = useRef({ x: 0.5, y: 0.5 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    let width = 0;
    let height = 0;
    let frame = 0;
    let running = false;
    let last = 0;

    const shipments: Shipment[] = LANES.flatMap((lane, index) =>
      Array.from({ length: 3 }, (_, slot) => ({
        // Spread along the route at the start, so the panel is never empty and
        // never has everything arriving at once.
        progress: (slot / 3 + index * 0.13) % 1,
        // Nearer lanes travel faster, which is the other half of the depth cue.
        speed: 0.05 + lane.alpha * 0.05,
        lane: index,
        landing: 0,
      })),
    );

    let waypoints: Waypoint[] = [];

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      // Capped at 2: a 3x phone screen triples the pixels drawn for a
      // difference nobody can see on a soft gradient.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);

      width = rect.width;
      height = rect.height;
      canvas!.width = Math.floor(width * ratio);
      canvas!.height = Math.floor(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);

      // Scattered once per size, not per frame, and deterministically enough
      // that a resize does not visibly reshuffle the field.
      const count = width < 640 ? 40 : 90;
      waypoints = Array.from({ length: count }, (_, index) => ({
        x: ((index * 97) % 100) / 100,
        y: ((index * 61) % 100) / 100,
        radius: 0.6 + ((index * 37) % 10) / 10,
        phase: ((index * 53) % 100) / 100,
        speed: 0.2 + ((index * 29) % 10) / 40,
      }));
    }

    /** The still frame: what someone who has asked for no motion sees. */
    function drawStill() {
      context!.clearRect(0, 0, width, height);
      drawWaypoints(0);
      for (const lane of LANES) drawLane(lane);
      drawDestination(0);
      for (const shipment of shipments) drawShipment(shipment, 0);
    }

    function drawWaypoints(time: number) {
      for (const point of waypoints) {
        const twinkle =
          0.45 + 0.4 * Math.sin(time * point.speed + point.phase * 6.3);
        context!.beginPath();
        context!.arc(
          point.x * width,
          point.y * height,
          point.radius,
          0,
          Math.PI * 2,
        );
        context!.fillStyle = `rgba(${PAPER}, ${twinkle})`;
        context!.fill();
      }
    }

    /** Dhaka: where everything is going, breathing gently. */
    function drawDestination(time: number) {
      const x = DESTINATION.x * width;
      const y = DESTINATION.y * height;
      const breath = 0.5 + 0.5 * Math.sin(time * 1.2);

      const halo = context!.createRadialGradient(x, y, 0, x, y, 46);
      halo.addColorStop(0, `rgba(${BRASS}, ${0.22 + breath * 0.1})`);
      halo.addColorStop(1, `rgba(${BRASS}, 0)`);
      context!.beginPath();
      context!.arc(x, y, 46, 0, Math.PI * 2);
      context!.fillStyle = halo;
      context!.fill();

      context!.beginPath();
      context!.arc(x, y, 5 + breath * 1.5, 0, Math.PI * 2);
      context!.fillStyle = `rgba(${PAPER}, 0.95)`;
      context!.fill();

      context!.beginPath();
      context!.arc(x, y, 13, 0, Math.PI * 2);
      context!.strokeStyle = `rgba(${BRASS}, ${0.35 + breath * 0.25})`;
      context!.lineWidth = 1.25;
      context!.stroke();
    }

    function drawLane(lane: (typeof LANES)[number]) {
      const from = pointOn(lane, 0, width, height);
      const to = pointOn(lane, 1, width, height);
      const control = {
        x: (lane.start * width + DESTINATION.x * width) / 2,
        y:
          Math.min(lane.y * height, DESTINATION.y * height) -
          lane.lift * height,
      };

      context!.beginPath();
      context!.moveTo(from.x, from.y);
      context!.quadraticCurveTo(control.x, control.y, to.x, to.y);
      context!.strokeStyle = `rgba(${SKY}, ${0.42 * lane.alpha})`;
      context!.lineWidth = 1.25;
      context!.setLineDash([5, 8]);
      context!.stroke();
      context!.setLineDash([]);

      // The two coasts: where a batch leaves, and where it lands.
      for (const [end, colour] of [
        [from, SKY],
        [to, BRASS],
      ] as const) {
        context!.beginPath();
        context!.arc(end.x, end.y, 3.5, 0, Math.PI * 2);
        context!.fillStyle = `rgba(${colour}, ${0.9 * lane.alpha})`;
        context!.fill();
      }
    }

    function drawShipment(shipment: Shipment, time: number) {
      const lane = LANES[shipment.lane];
      const head = pointOn(lane, shipment.progress, width, height);

      // A short trail behind it, fading out — enough to read as travelling
      // rather than as a dot that has been placed there.
      for (let step = 1; step <= 16; step++) {
        const t = Math.max(0, shipment.progress - step * 0.014);
        const tail = pointOn(lane, t, width, height);
        context!.beginPath();
        context!.arc(tail.x, tail.y, 2.4 - step * 0.12, 0, Math.PI * 2);
        context!.fillStyle = `rgba(${BRASS}, ${(0.55 - step * 0.033) * lane.alpha})`;
        context!.fill();
      }

      const radius = 22 * lane.alpha + 8;
      const glow = context!.createRadialGradient(
        head.x,
        head.y,
        0,
        head.x,
        head.y,
        radius,
      );
      glow.addColorStop(0, `rgba(${BRASS}, ${0.9 * lane.alpha})`);
      glow.addColorStop(0.4, `rgba(${BRASS}, ${0.25 * lane.alpha})`);
      glow.addColorStop(1, `rgba(${BRASS}, 0)`);
      context!.beginPath();
      context!.arc(head.x, head.y, radius, 0, Math.PI * 2);
      context!.fillStyle = glow;
      context!.fill();

      context!.beginPath();
      context!.arc(head.x, head.y, 3, 0, Math.PI * 2);
      context!.fillStyle = `rgba(${PAPER}, ${lane.alpha})`;
      context!.fill();

      // The arrival: a ring opening at the landing coast.
      if (shipment.landing > 0) {
        const landed = pointOn(lane, 1, width, height);
        const spread = 1 - shipment.landing;

        for (const [scale, weight] of [
          [1, 2],
          [0.55, 1.25],
        ] as const) {
          context!.beginPath();
          context!.arc(
            landed.x,
            landed.y,
            5 + spread * 46 * scale,
            0,
            Math.PI * 2,
          );
          context!.strokeStyle = `rgba(${BRASS}, ${shipment.landing * 0.75 * lane.alpha})`;
          context!.lineWidth = weight;
          context!.stroke();
        }
      }

      void time;
    }

    function render(now: number) {
      if (!running) return;

      const elapsed = last === 0 ? 0 : Math.min((now - last) / 1000, 0.05);
      last = now;
      const time = now / 1000;

      context!.clearRect(0, 0, width, height);

      /*
       * Parallax. The whole scene leans a few pixels towards the pointer, which
       * is what makes a flat panel feel like it has depth. Small on purpose:
       * a hero that lurches under the cursor is a hero nobody can read.
       */
      const offsetX = (pointerRef.current.x - 0.5) * 18;
      const offsetY = (pointerRef.current.y - 0.5) * 10;

      context!.save();
      context!.translate(offsetX, offsetY);

      drawWaypoints(time);
      for (const lane of LANES) drawLane(lane);
      drawDestination(time);

      for (const shipment of shipments) {
        shipment.progress += shipment.speed * elapsed;

        if (shipment.progress >= 1) {
          shipment.progress = 0;
          // One second of landing ring, counted down rather than timed, so a
          // background tab cannot leave it half-drawn.
          shipment.landing = 1;
        }

        if (shipment.landing > 0) {
          shipment.landing = Math.max(0, shipment.landing - elapsed * 1.1);
        }

        drawShipment(shipment, time);
      }

      context!.restore();

      frame = requestAnimationFrame(render);
    }

    function start() {
      if (running || reduced.matches) return;
      running = true;
      last = 0;
      frame = requestAnimationFrame(render);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(frame);
    }

    function onPointerMove(event: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      pointerRef.current = {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      };
    }

    function onPointerLeave() {
      pointerRef.current = { x: 0.5, y: 0.5 };
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") stop();
      else start();
    }

    function onMotionPreference() {
      stop();
      resize();
      if (reduced.matches) drawStill();
      else start();
    }

    resize();
    if (reduced.matches) drawStill();
    else start();

    // Stops completely once scrolled past: there is no reason to burn a frame
    // budget animating something nobody is looking at.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) start();
          else stop();
        }
      },
      { threshold: 0 },
    );
    observer.observe(canvas);

    const onResize = () => {
      resize();
      if (reduced.matches) drawStill();
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    reduced.addEventListener("change", onMotionPreference);

    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      reduced.removeEventListener("change", onMotionPreference);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      /*
       * Decorative, and the text above it must stay readable: the canvas never
       * draws anything solid enough to move the contrast of the headline, and
       * the ink gradient underneath is what the contrast is measured against.
       */
      className="pointer-events-auto absolute inset-0 size-full"
    />
  );
}
