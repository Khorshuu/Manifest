"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { BackgroundTone } from "@/lib/hero-tone";

/**
 * What the header is currently sitting on.
 *
 * The header is one component across the whole storefront, but on the home page
 * it floats over the hero photograph rather than standing on a bar of its own.
 * That means two things have to travel from the hero, which is far away in the
 * tree, back up to the header: how light the current slide is, and whether the
 * page has been scrolled past the hero altogether.
 *
 * A context rather than a prop because the header is rendered by the layout and
 * the hero by the page — neither can hand the other anything directly.
 */
type HeroReport = {
  /** Lightness of the imagery behind the header on the current slide. */
  tone: BackgroundTone;
  /** The hero has scrolled away; the header needs a surface of its own again. */
  scrolledPast: boolean;
  /** The route the hero that said so was on. See below. */
  route: string;
};

type HeaderStore = {
  tone: BackgroundTone;
  scrolledPast: boolean;
  /** True while the header is drawn over a hero instead of on a bar. */
  floating: boolean;
  report: (next: Partial<Omit<HeroReport, "route">>) => void;
};

const HeaderThemeContext = createContext<HeaderStore | null>(null);

/**
 * The routes whose first screen is a hero the header sits inside.
 *
 * Derived from the path rather than announced by the hero on mount, and that is
 * deliberate: an announcement only arrives after hydration, so the server would
 * render the solid bar and the browser would swap it a moment later — a visible
 * flash on the first screen of the site. A second overlay route is one entry.
 */
const OVERLAY_ROUTES = new Set(["/"]);

export function HeaderThemeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  /*
   * "light" to begin with because the catalogue's imagery is shot on pale
   * grounds, so the navy treatment is the likelier first answer and the
   * measurement below usually confirms rather than corrects it.
   */
  const [report, setReport] = useState<HeroReport>({
    tone: "light",
    scrolledPast: false,
    route: "/",
  });

  const update = useCallback(
    (next: Partial<Omit<HeroReport, "route">>) => {
      setReport((current) => {
        const merged = { ...current, ...next, route: pathname };
        if (
          merged.tone === current.tone &&
          merged.scrolledPast === current.scrolledPast &&
          merged.route === current.route
        ) {
          return current;
        }
        return merged;
      });
    },
    [pathname],
  );

  /*
   * A report is only about the route it was made on.
   *
   * Leaving the home page part-way down it and coming back would otherwise
   * arrive with "scrolled past" still true, and the header would open over the
   * top of the photograph as a solid bar. Reading the route off the report is
   * how that is forgotten without an effect that sets state on every
   * navigation.
   */
  const current = report.route === pathname ? report : { ...report, scrolledPast: false };

  const value = useMemo<HeaderStore>(
    () => ({
      tone: current.tone,
      scrolledPast: current.scrolledPast,
      floating: OVERLAY_ROUTES.has(pathname) && !current.scrolledPast,
      report: update,
    }),
    [current.tone, current.scrolledPast, pathname, update],
  );

  return (
    <HeaderThemeContext.Provider value={value}>
      {children}
    </HeaderThemeContext.Provider>
  );
}

/**
 * Outside the provider — in a test that mounts the header on its own, say — the
 * header simply stands on its own bar, which is the safe answer rather than an
 * exception.
 */
const STANDALONE: HeaderStore = {
  tone: "light",
  scrolledPast: true,
  floating: false,
  report: () => {},
};

export function useHeaderTheme(): HeaderStore {
  return useContext(HeaderThemeContext) ?? STANDALONE;
}
