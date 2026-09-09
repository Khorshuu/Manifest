"use client";

import { useState } from "react";
import { IconPause, IconPlay } from "./icons";

/**
 * The manifest strip: a departure-board line that runs under the hero.
 *
 * Everything on it is true — the lane the goods travel, what is already inside
 * the price, and the batches that are actually open right now. A ticker of
 * invented slogans would be decoration; this one is the shipping notice a
 * freight office would have on the wall.
 *
 * Moving content that starts on its own has to be stoppable (WCAG 2.2.2), so
 * there is a real button rather than a hover-only pause, which a keyboard user
 * could never reach. Anyone who has asked their system to reduce motion gets a
 * still strip and no animation at all.
 */
export function Ticker({ items }: { items: string[] }) {
  const [running, setRunning] = useState(true);

  if (items.length === 0) return null;

  // Two identical passes make the loop seamless: the second is a copy, so it
  // is hidden from assistive technology rather than read twice.
  const pass = (hidden: boolean) => (
    <ul
      aria-hidden={hidden ? "true" : undefined}
      className="flex shrink-0 items-center gap-10 pr-10"
    >
      {items.map((item, index) => (
        <li key={`${item}-${index}`} className="flex items-center gap-10">
          <span className="whitespace-nowrap text-meta uppercase tracking-[0.18em] text-paper/75">
            {item}
          </span>
          <span aria-hidden="true" className="size-1 rounded-full bg-brass" />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="relative flex items-center border-y border-paper/15 bg-ink-deep">
      <div className="marquee-mask flex-1 overflow-hidden py-2.5">
        <div
          className="marquee flex w-max"
          data-running={running ? "true" : "false"}
        >
          {pass(false)}
          {pass(true)}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setRunning((current) => !current)}
        aria-pressed={running ? "false" : "true"}
        className="mr-2 inline-flex min-h-11 shrink-0 items-center gap-2 rounded-control px-3 text-meta text-paper/70 transition-colors hover:text-brass"
      >
        {running ? <IconPause size={14} /> : <IconPlay size={14} />}
        {running ? "Hold" : "Run"}
        <span className="sr-only">the manifest strip</span>
      </button>
    </div>
  );
}
