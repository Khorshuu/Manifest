import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

export type Variant = "primary" | "secondary" | "quiet" | "danger";
export type Size = "sm" | "md" | "lg";

/**
 * One button, four weights, three sizes — and one recipe shared with the link
 * version below.
 *
 * The press is the important part: every variant sinks slightly under the
 * pointer, because a control that does not answer a click feels broken even
 * when the request behind it succeeded. `active:` states are CSS, so they land
 * on the first frame rather than waiting for JavaScript.
 *
 * `buttonClass` exists because a link that acts as a button has to *look*
 * identical to one. Before this, 41 separate places hand-wrote
 * `inline-flex min-h-11 items-center rounded-control border border-blue-300…`
 * and quietly disagreed about padding, weight and hover, which is the single
 * biggest reason the quieter screens looked unfinished next to the storefront.
 */
const base =
  "inline-flex items-center justify-center gap-2 rounded-control font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out " +
  "active:scale-[0.985] active:duration-75 " +
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 disabled:shadow-none " +
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

const sizes: Record<Size, string> = {
  // 44px stays the floor on every size — the touch-target minimum applies to
  // the small variant too, so `sm` buys tighter horizontal padding, not a
  // shorter control.
  sm: "min-h-11 px-3 text-meta",
  md: "min-h-11 px-4 text-body",
  lg: "min-h-[3.25rem] px-6 text-body",
};

const variants: Record<Variant, string> = {
  // brass is the CTA accent so buy actions never get lost against blue nav and
  // links; it is the only element on the page that carries a warm shadow.
  primary:
    "surface-brass sheen text-ink shadow-[var(--shadow-raise)] hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04]",
  secondary:
    "border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]",
  quiet: "text-blue-600 hover:bg-blue-50 hover:text-blue-500",
  // Destructive actions carry the semantic colour and stay visually separate
  // from the primary one, rather than being a quiet link that deletes things.
  danger:
    "border border-stamp-red bg-paper text-stamp-red-text hover:bg-stamp-red/10",
};

export function buttonClass({
  variant = "primary",
  size = "md",
  className = "",
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}) {
  return `${base} ${sizes[size]} ${variants[variant]} ${className}`.trim();
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  return <button {...props} className={buttonClass({ variant, size, className })} />;
}

export type LinkButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: Variant;
  size?: Size;
  children: ReactNode;
};

/**
 * A link that navigates but reads as a control. It is a real anchor — so it
 * opens in a new tab, gets a right-click menu and is crawled — while sharing
 * the button recipe exactly.
 */
export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: LinkButtonProps) {
  return (
    <Link
      href={href}
      {...props}
      className={buttonClass({ variant, size, className })}
    >
      {children}
    </Link>
  );
}
