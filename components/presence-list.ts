"use client";

import { useEffect, useState } from "react";

export type PresenceEntry<T> = {
  item: T;
  key: string;
  /** Arrived after the list first rendered, so it plays an entrance. */
  entering: boolean;
  /** Gone from the data; still drawn until its exit has played. */
  leaving: boolean;
};

/**
 * Keeps removed items on screen long enough to animate out.
 *
 * This is the one thing the cart used Framer Motion's `AnimatePresence` for,
 * and that alone put about 20 KB gzip on the cart's first load
 * (PRODUCTION-READINESS 12.1). The movement itself is CSS: an entering row
 * rises in, a leaving row slides away while its height collapses, so the rows
 * below close the gap smoothly. The global reduced-motion rule in
 * app/globals.css switches all of it off.
 *
 * A removed item keeps its old position; an item that comes back before its
 * exit finishes is simply present again.
 */
export function usePresenceList<T>(
  items: T[],
  keyOf: (item: T) => string,
  exitMs: number,
): PresenceEntry<T>[] {
  const [initialKeys] = useState(() => new Set(items.map(keyOf)));
  const [previous, setPrevious] = useState(items);
  const [leaving, setLeaving] = useState<{ item: T; key: string; index: number }[]>([]);

  // Derived during render when the data changes, React's pattern for state
  // that follows a prop, so the leaving row never disappears for a frame.
  if (previous !== items) {
    const current = new Set(items.map(keyOf));
    const removed = previous
      .map((item, index) => ({ item, key: keyOf(item), index }))
      .filter((entry) => !current.has(entry.key));
    setPrevious(items);
    setLeaving((existing) => [
      ...existing.filter((entry) => !current.has(entry.key) && !removed.some((r) => r.key === entry.key)),
      ...removed,
    ]);
  }

  useEffect(() => {
    if (leaving.length === 0) return;
    const timer = setTimeout(() => setLeaving([]), exitMs);
    return () => clearTimeout(timer);
  }, [leaving, exitMs]);

  const entries: PresenceEntry<T>[] = items.map((item) => {
    const key = keyOf(item);
    return { item, key, entering: !initialKeys.has(key), leaving: false };
  });
  for (const gone of [...leaving].sort((a, b) => a.index - b.index)) {
    entries.splice(Math.min(gone.index, entries.length), 0, {
      item: gone.item,
      key: gone.key,
      entering: false,
      leaving: true,
    });
  }
  return entries;
}
