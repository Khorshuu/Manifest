import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "quiet";

const base =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 text-body font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-60";

const variants: Record<Variant, string> = {
  // brass is the CTA accent so buy actions never get lost against blue nav and links
  primary: "bg-brass text-ink hover:bg-brass/90",
  secondary:
    "border border-blue-300 bg-paper text-blue-600 hover:border-blue-500",
  quiet: "text-blue-600 hover:text-blue-500",
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
