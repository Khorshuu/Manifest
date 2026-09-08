import type { InputHTMLAttributes } from "react";

export type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Shown beneath the input, in words that say how to fix the problem. */
  error?: string;
  hint?: string;
};

/**
 * Every input carries a visible, persistent label — placeholders are examples,
 * never labels (docs/DESIGN_GUIDELINES.md).
 */
export function Field({
  label,
  error,
  hint,
  id,
  className = "",
  ...props
}: FieldProps) {
  const inputId = id ?? props.name;
  const errorId = error ? `${inputId}-error` : undefined;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-meta font-medium text-ink">
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(" ") || undefined}
        className={`min-h-11 rounded-control border bg-paper px-3 text-body text-ink ${
          error ? "border-stamp-red" : "border-blue-300"
        } ${className}`.trim()}
      />
      {hint ? (
        <p id={hintId} className="text-meta text-ink/70">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-meta text-stamp-red-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
