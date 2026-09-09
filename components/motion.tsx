"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The entrance vocabulary, in one place.
 *
 * Two earlier attempts at this were wrong in instructive ways, and the rule
 * they arrived at is worth stating plainly: **an entrance may never be the
 * reason something cannot be read.**
 *
 * The first attempt used Framer Motion's `whileInView`, which puts
 * `opacity: 0` into the server-rendered HTML. Anyone whose JavaScript failed,
 * and every preview or crawler that does not scroll, got a page that was
 * present in the DOM and blank on the screen.
 *
 * The second used CSS `animation-timeline: view()`. That removes the JavaScript
 * but scroll-driven animations are *scrubbed*, not played: scrolling back up
 * runs them backwards, so a section that had been read faded out again.
 *
 * What is here now hides nothing until the browser has confirmed it can put it
 * back. On mount it looks at what is genuinely below the fold, hides only
 * that, and plays each one once as it arrives. Anything already on screen is
 * never touched, so there is no flash; anyone who has asked for reduced motion
 * is never touched either, which matters because for some people this movement
 * causes real nausea.
 */

/** Roughly a fifth of a screen below the fold: far enough not to flash. */
const SAFE_MARGIN = 0.9;

function useEntrance(
  ref: React.RefObject<HTMLDivElement | null>,
  { children: staggerChildren }: { children: boolean },
) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const targets = staggerChildren
      ? (Array.from(root.children) as HTMLElement[])
      : [root];

    // Only what is below the fold right now. Hiding something the visitor can
    // already see would make it blink out and back in.
    const pending = targets.filter(
      (target) =>
        target.getBoundingClientRect().top > window.innerHeight * SAFE_MARGIN,
    );
    if (pending.length === 0) return;

    for (const target of pending) target.classList.add("will-arrive");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          // The sequence within one group, capped so a long grid does not end
          // up waiting most of a second for its last card.
          const order = Math.min(pending.indexOf(target), 5);
          target.style.animationDelay = `${order * 55}ms`;
          target.classList.add("arrived");
          observer.unobserve(target);
        }
      },
      { threshold: 0.12 },
    );

    for (const target of pending) observer.observe(target);
    return () => observer.disconnect();
  }, [ref, staggerChildren]);
}

/** A section that rises into place the first time it is scrolled to. */
export function Reveal({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEntrance(ref, { children: false });

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** A group whose children arrive one after another rather than all at once. */
export function Stagger({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEntrance(ref, { children: true });

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/**
 * One item inside a Stagger.
 *
 * It carries no behaviour of its own — the group hides and reveals its own
 * children — but it keeps the call sites readable and gives each item a single
 * element to be animated, which a fragment would not.
 */
export function StaggerItem({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={className}>{children}</div>;
}
