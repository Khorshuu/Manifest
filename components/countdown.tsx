"use client";

import { useEffect, useState } from "react";
import { IconClock } from "./icons";

/**
 * Time left in a preorder window, as a departure board.
 *
 * The split-flap is the one loud thing on the page, and it is loud for a
 * reason: this shop is goods crossing a border on a stated schedule, and the
 * moment the window shuts is the single fact a shopper is deciding against.
 * Everything around it is kept quiet so this can carry the weight.
 *
 * The first paint is computed on the server, so it does not flash empty, and a
 * visitor without JavaScript still sees a correct figure — one that does not
 * tick.
 */

export type CountdownParts = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  closed: boolean;
};

export function countdownParts(closesAt: Date, now: number): CountdownParts {
  const remaining = closesAt.getTime() - now;

  if (remaining <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, closed: true };
  }

  const seconds = Math.floor(remaining / 1000);

  return {
    days: Math.floor(seconds / 86_400),
    hours: Math.floor((seconds % 86_400) / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    seconds: seconds % 60,
    closed: false,
  };
}

/** "3 days, 4 hours" — the sentence a person would say out loud. */
export function countdownLabel(parts: CountdownParts): string {
  if (parts.closed) return "Closed";

  const plural = (value: number, unit: string) =>
    `${value} ${unit}${value === 1 ? "" : "s"}`;

  if (parts.days > 0) {
    return `${plural(parts.days, "day")}, ${plural(parts.hours, "hour")}`;
  }

  if (parts.hours > 0) {
    return `${plural(parts.hours, "hour")}, ${plural(parts.minutes, "minute")}`;
  }

  return `${plural(parts.minutes, "minute")}, ${plural(parts.seconds, "second")}`;
}

type Tone = "light" | "dark";

/**
 * One flap. The split line across the middle and the shadow above it are what
 * make it read as a mechanical board rather than a number in a box.
 */
function Flap({
  value,
  unit,
  tone,
}: {
  value: number;
  unit: string;
  tone: Tone;
}) {
  const dark = tone === "dark";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={`relative min-w-[3.75rem] overflow-hidden rounded-[3px] px-3 py-2 shadow-[var(--shadow-raise)] ${
          dark
            ? "bg-gradient-to-b from-[#16233c] to-ink-deep"
            : "bg-gradient-to-b from-[#1b3157] to-ink"
        }`}
      >
        {/* Keyed on the value, so each change flips rather than swapping. */}
        <span
          key={value}
          className="animate-flap block text-center font-display text-[2rem] leading-none tabular-nums text-paper"
        >
          {String(value).padStart(2, "0")}
        </span>

        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-1/2 h-px bg-black/45"
        />
      </div>

      <span
        className={`text-meta lowercase ${dark ? "text-paper/55" : "text-ink/70"}`}
      >
        {unit}
      </span>
    </div>
  );
}

export function Countdown({
  closesAt,
  variant = "blocks",
  tone = "light",
  serverNow,
}: {
  closesAt: string;
  variant?: "blocks" | "inline";
  tone?: Tone;
  /**
   * The instant the server rendered at, in milliseconds.
   *
   * Without it the first client render reads its own clock, which is never the
   * same number the server used — so React finds "39" where the HTML says "40"
   * and throws the whole subtree away with a hydration error in the console.
   * Passing the server's instant down makes the first render on both sides
   * identical; the interval below takes over immediately afterwards.
   */
  serverNow?: number;
}) {
  const closing = new Date(closesAt);
  const [now, setNow] = useState(() => serverNow ?? Date.now());

  useEffect(() => {
    // A whole second is enough: nothing here changes faster, and a tighter
    // interval would wake the tab for no visible reason.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const parts = countdownParts(closing, now);

  if (parts.closed) {
    return (
      <p className="flex items-center gap-1.5 text-meta text-stamp-red-text">
        <IconClock size={14} className="shrink-0" />
        This window has closed.
      </p>
    );
  }

  if (variant === "inline") {
    return (
      <p
        className={`flex items-center gap-1.5 text-meta ${
          tone === "dark" ? "text-paper/70" : "text-ink/70"
        }`}
      >
        <IconClock size={14} className="shrink-0" />
        Closes in{" "}
        <span
          role="timer"
          aria-label={`Preorder closes in ${countdownLabel(parts)}`}
          className={`font-medium tabular-nums ${
            tone === "dark" ? "text-paper" : "text-ink"
          }`}
        >
          {countdownLabel(parts)}
        </span>
      </p>
    );
  }

  return (
    <div>
      <p
        className={`text-meta ${tone === "dark" ? "text-paper/60" : "text-ink/70"}`}
      >
        Ordering closes in
      </p>

      <div
        className="mt-2 flex flex-wrap items-start gap-1.5"
        // One announcement, not four ticking numbers read aloud separately.
        role="timer"
        aria-label={`Preorder closes in ${countdownLabel(parts)}`}
      >
        <Flap value={parts.days} unit="days" tone={tone} />
        <Flap value={parts.hours} unit="hours" tone={tone} />
        <Flap value={parts.minutes} unit="mins" tone={tone} />
        <Flap value={parts.seconds} unit="secs" tone={tone} />
      </div>
    </div>
  );
}
