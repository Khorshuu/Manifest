import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "quiet";

/**
 * One button, three weights.
 *
 * The press is the important part: every variant sinks slightly under the
 * pointer, because a control that does not answer a click feels broken even
 * when the request behind it succeeded. `active:` states are CSS, so they land
 * on the first frame rather than waiting for JavaScript.
 */
const base =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 text-body font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out " +
  "active:scale-[0.985] active:duration-75 " +
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 disabled:shadow-none";

const variants: Record<Variant, string> = {
  // brass is the CTA accent so buy actions never get lost against blue nav and
  // links; it is the only element on the page that carries a warm shadow.
  primary:
    "surface-brass sheen text-ink shadow-[var(--shadow-raise)] hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04]",
  secondary:
    "border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]",
  quiet: "text-blue-600 hover:bg-blue-50 hover:text-blue-500",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={`${base} ${variants[variant]} ${className}`.trim()}
    />
  );
}
