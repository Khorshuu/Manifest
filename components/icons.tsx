import type { SVGProps } from "react";

/**
 * The icon set.
 *
 * docs/DESIGN_GUIDELINES.md asks for "simple single-line icons (not
 * filled/coloured illustrations)" and there were none — every place that
 * wanted one either used a text bullet, a bare arrow character, or nothing,
 * which is a large part of why the pale sections read as unfinished.
 *
 * They are hand-drawn rather than pulled from a library for three reasons that
 * matter here: the home page is measured against a JavaScript budget and these
 * cost nothing at runtime; the shapes can carry the shipping-document identity
 * (square corners, ruled lines, a customs stamp) instead of a generic app
 * language; and one file guarantees the stroke width, cap and grid are the
 * same everywhere, which is the thing that actually makes an icon set look
 * professional.
 *
 * Rules, kept in one place so they cannot drift:
 * - 24×24 grid, 1.5 stroke, round caps and joins, `currentColor` only.
 * - Decorative by default: `aria-hidden` is on unless a `title` is passed,
 *   because almost every icon here sits beside its own visible label and a
 *   screen reader should not read the label twice.
 */

export type IconProps = SVGProps<SVGSVGElement> & {
  /** Only for an icon that stands alone. Beside a visible label, leave it off. */
  title?: string;
  size?: number;
};

function Icon({ title, size = 24, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** A crate under a strap — what actually crosses the water. */
export function IconCrate(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
      <path d="M3 7.5 12 12l9-4.5M12 12v9" />
    </Icon>
  );
}

/** A price tag: the landed figure. */
export function IconTag(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12.5V4a1 1 0 0 1 1-1h8.5L21 11.5 13.5 19z" />
      <circle cx="7.5" cy="7.5" r="1.25" />
    </Icon>
  );
}

/** A stamped document — the manifest itself. */
export function IconManifest(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 3h9l5 5v13H5z" />
      <path d="M14 3v5h5M8.5 12.5h7M8.5 16h4.5" />
    </Icon>
  );
}

/** A window of dates. */
export function IconCalendar(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="1" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    </Icon>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7v5.25l3.25 2" />
    </Icon>
  );
}

/** An aircraft, seen from below: the leg that crosses. */
export function IconPlane(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.75c.9 0 1.6 1.4 1.6 3.1v3.4l7.4 4.3v2.2l-7.4-2.3v3.9l2.4 1.8v1.6L12 19.5l-4 1.25v-1.6l2.4-1.8v-3.9L3 15.75v-2.2l7.4-4.3v-3.4c0-1.7.7-3.1 1.6-3.1z" />
    </Icon>
  );
}

/** The last mile. */
export function IconTruck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 6.5h11v9.25h-11zM13.75 10h3.6l3.9 3.4v2.35h-7.5z" />
      <circle cx="7" cy="18" r="1.75" />
      <circle cx="17" cy="18" r="1.75" />
    </Icon>
  );
}

/** A customs seal: duty already paid. */
export function IconSeal(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.75 14.3 5l3.1-.4.9 3 2.7 1.6-1.4 2.8 1.4 2.8-2.7 1.6-.9 3-3.1-.4L12 21.25 9.7 19l-3.1.4-.9-3-2.7-1.6L4.4 12 3 9.2l2.7-1.6.9-3 3.1.4z" />
      <path d="m8.75 12 2.25 2.25 4.25-4.5" />
    </Icon>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.75 4.75 5.5v6c0 4.35 2.9 8.1 7.25 9.75 4.35-1.65 7.25-5.4 7.25-9.75v-6z" />
      <path d="m8.75 11.75 2.25 2.25 4.25-4.5" />
    </Icon>
  );
}

export function IconCart(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 3.5h2.6l2.4 11h9.9l2.1-7.5H6.2" />
      <circle cx="9.25" cy="19" r="1.5" />
      <circle cx="16.75" cy="19" r="1.5" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.75" cy="10.75" r="7" />
      <path d="m15.9 15.9 4.6 4.6" />
    </Icon>
  );
}

export function IconUser(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.75 20.25c0-3.6 3.25-5.75 7.25-5.75s7.25 2.15 7.25 5.75" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.75 12.5 4.75 4.75 9.75-10.5" />
    </Icon>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12h16M14 6l6 6-6 6" />
    </Icon>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12H4M10 6l-6 6 6 6" />
    </Icon>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 9 7 7 7-7" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7.5v5.25M12 16.25h.01" />
    </Icon>
  );
}

/** An empty crate: nothing filed here yet. */
export function IconEmptyCrate(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 8.5h17.5v11.25H3.25z" />
      <path d="M3.25 8.5 6 4.25h12l2.75 4.25M9.5 12.25h5" />
    </Icon>
  );
}

/** A pair of scales — what a batch costs against what it holds. */
export function IconStack(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.25 21 8l-9 4.75L3 8z" />
      <path d="m3 12.5 9 4.75 9-4.75M3 16.75 12 21.5l9-4.75" />
    </Icon>
  );
}

export function IconStar(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 3.5 2.65 5.55 6.1.8-4.45 4.2 1.15 6-5.45-2.95L6.55 20l1.15-6L3.25 9.85l6.1-.8z" />
    </Icon>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 5v14M15 5v14" />
    </Icon>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 4.75 19 12 7 19.25z" />
    </Icon>
  );
}

/** A route between two points: New York to Dhaka. */
export function IconRoute(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="18.5" r="2.25" />
      <circle cx="19" cy="5.5" r="2.25" />
      <path strokeDasharray="2.5 2.5" d="M7 16.5C10 13 9 9 13 8.5c2 -.25 3.5 -1 4.5 -1.5" />
    </Icon>
  );
}
