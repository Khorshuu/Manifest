"use client";

import { useState, type InputHTMLAttributes } from "react";
import { IconAlert } from "./icons";

export type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Shown beneath the input, in words that say how to fix the problem. */
  error?: string;
  hint?: string;
};

/**
 * Every input carries a visible, persistent label — placeholders are examples,
 * never labels (docs/DESIGN_GUIDELINES.md).
 *
 * Two things were added here rather than in each form, so every field on the
 * site gains them at once: a required marker, because "required" was previously
 * only discoverable by submitting; and a reveal control on password fields,
 * which is the standard remedy for a typo you cannot see and which the UX
 * guidance asks for by name.
 */
export function Field({
  label,
  error,
  hint,
  id,
  className = "",
  type = "text",
  ...props
}: FieldProps) {
  const inputId = id ?? props.name;
  const errorId = error ? `${inputId}-error` : undefined;
  const hintId = hint ? `${inputId}-hint` : undefined;

  const isPassword = type === "password";
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {/*
       * The required marker sits beside the label, not inside it.
       *
       * A `<label>`'s text becomes the field's accessible name, so anything
       * added in there renames the field — "Email" became "Email *", and
       * every caller addressing the field by its name stopped finding it.
       * Outside the label the mark is purely visual, which is all it was ever
       * meant to be: a screen reader is already told the field is required by
       * the `required` attribute on the input itself.
       */}
      <div className="flex items-baseline gap-1">
        <label htmlFor={inputId} className="text-meta font-medium text-ink">
          {label}
        </label>
        {props.required ? (
          <span aria-hidden="true" className="text-stamp-red-text">
            *
          </span>
        ) : null}
      </div>

      <div className="relative">
        <input
          {...props}
          type={isPassword && revealed ? "text" : type}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [errorId, hintId].filter(Boolean).join(" ") || undefined
          }
          className={`min-h-11 w-full rounded-control border bg-paper px-3 text-body text-ink ${
            isPassword ? "pr-20" : ""
          } ${error ? "border-stamp-red" : "border-blue-300"} ${className}`.trim()}
        />

        {isPassword ? (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            className="absolute inset-y-0 right-0 inline-flex min-h-11 items-center rounded-r-control px-3 text-meta text-blue-600 transition-colors hover:bg-blue-50"
          >
            {revealed ? "Hide" : "Show"}
            <span className="sr-only"> password</span>
          </button>
        ) : null}
      </div>

      {hint ? (
        <p id={hintId} className="text-meta text-ink/70">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          className="flex items-start gap-1.5 text-meta text-stamp-red-text"
        >
          <IconAlert size={15} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
