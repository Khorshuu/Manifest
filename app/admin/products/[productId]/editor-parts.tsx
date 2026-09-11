"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/button";
import { IconAlert, IconCheck, IconMinus, IconPlus } from "@/components/icons";

/**
 * The pieces every section of the product editor is built from.
 *
 * They exist so the eight panels share one save behaviour, one message
 * treatment, and one set of controls: before this each form re-implemented
 * "post, catch, show a red line", and they disagreed about all three.
 */

const inputClass =
  "min-h-11 w-full rounded-control border border-blue-300 bg-paper px-3 text-body text-ink";
const areaClass =
  "w-full rounded-control border border-blue-300 bg-paper p-3 text-body text-ink";

export { inputClass, areaClass };

/**
 * Saves a slice of a product.
 *
 * Only the fields a panel owns are sent. The API applies a partial update, so
 * a panel cannot erase a field belonging to another one — which is what makes
 * splitting this form into sections safe at all.
 */
export function useProductSave(productId: string, onSaved?: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const save = useCallback(
    async (payload: Record<string, unknown>) => {
      setPending(true);
      setError(null);
      setMessage(null);

      const response = await fetch(`/api/admin/products/${productId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      setPending(false);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "Something went wrong. Try again.");
        window.dispatchEvent(new Event("product-editor-save-failed"));
        return false;
      }

      setMessage("Saved.");
      setDirty(false);
      onSaved?.();
      window.dispatchEvent(new Event("product-editor-saved"));
      return true;
    },
    [productId, onSaved],
  );

  return {
    save,
    pending,
    error,
    message,
    dirty,
    markDirty: () => {
      setDirty(true);
      setMessage(null);
    },
    setError,
  };
}

export function FormStatus({
  error,
  message,
}: {
  error: string | null;
  message: string | null;
}) {
  return (
    <div aria-live="polite" className="min-h-6">
      {error ? (
        <p className="flex items-start gap-2 text-meta text-stamp-red-text">
          <IconAlert size={15} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : message ? (
        <p className="flex items-center gap-2 text-meta text-transit-green-text">
          <IconCheck size={15} className="shrink-0" />
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The save bar every panel ends with.
 *
 * It says whether there is anything to save, so a staff member can tell a
 * saved panel from an edited one at a glance — the unsaved-change protection
 * the brief asks for, done by showing the state rather than by intercepting
 * navigation.
 */
export function SaveRow({
  pending,
  dirty,
  error,
  message,
  label = "Save",
}: {
  pending: boolean;
  dirty: boolean;
  error: string | null;
  message: string | null;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /*
   * Marks the surrounding form as unsaved, and tells the product action bar,
   * which saves every unsaved panel at once and warns before leaving.
   */
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    form.dataset.dirty = dirty ? "true" : "false";
    window.dispatchEvent(new Event("product-editor-dirty"));
  }, [dirty]);

  return (
    <div ref={ref} className="flex flex-wrap items-center gap-4 border-t border-blue-300 pt-4">
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : label}
      </Button>
      {dirty && !pending ? (
        <span className="text-meta text-brass-text">Unsaved changes</span>
      ) : null}
      <FormStatus error={error} message={message} />
    </div>
  );
}

export function LabelledField({
  label,
  htmlFor,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline gap-1">
        <label htmlFor={htmlFor} className="text-meta font-medium text-ink">
          {label}
        </label>
        {required ? (
          <span aria-hidden="true" className="text-stamp-red-text">
            *
          </span>
        ) : null}
      </div>
      {children}
      {hint ? <p className="text-meta text-ink/70">{hint}</p> : null}
    </div>
  );
}

/**
 * A counted text input, for the two fields where length decides whether the
 * result reads well in a search listing rather than whether it is valid.
 */
export function CountedInput({
  id,
  label,
  value,
  onChange,
  ideal,
  hint,
  multiline,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  ideal: number;
  hint?: string;
  multiline?: boolean;
}) {
  const over = value.length > ideal;

  return (
    <LabelledField
      label={label}
      htmlFor={id}
      hint={hint}
    >
      {multiline ? (
        <textarea
          id={id}
          rows={3}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={areaClass}
        />
      ) : (
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        />
      )}
      <p className={`text-meta ${over ? "text-brass-text" : "text-ink/70"}`}>
        {value.length} of about {ideal} characters
        {over ? " — search results will cut this short." : ""}
      </p>
    </LabelledField>
  );
}

/**
 * An ordered list of short lines — highlights, what's in the box, keywords.
 *
 * Order is the point: these render in this order on the product page, so the
 * editor has to be able to move a line as well as add one. Kept as buttons
 * rather than drag handles, because a keyboard user has to be able to reorder
 * them too.
 */
export function ListEditor({
  label,
  hint,
  items,
  onChange,
  placeholder,
  addLabel = "Add another",
}: {
  label: string;
  hint?: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel?: string;
}) {
  const set = (index: number, value: string) => {
    const next = [...items];
    next[index] = value;
    onChange(next);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="text-meta font-medium text-ink">{label}</legend>
      {hint ? <p className="text-meta text-ink/70">{hint}</p> : null}

      {items.length === 0 ? (
        <p className="text-meta text-ink/70">Nothing yet.</p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {items.map((item, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2">
            <input
              value={item}
              placeholder={placeholder}
              aria-label={`${label} ${index + 1}`}
              onChange={(event) => set(index, event.target.value)}
              className={`${inputClass} min-w-0 flex-1`}
            />
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                className="inline-flex size-11 items-center justify-center rounded-control border border-blue-300 text-blue-600 disabled:opacity-40"
              >
                <span aria-hidden="true">↑</span>
                <span className="sr-only">Move {label} {index + 1} up</span>
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === items.length - 1}
                className="inline-flex size-11 items-center justify-center rounded-control border border-blue-300 text-blue-600 disabled:opacity-40"
              >
                <span aria-hidden="true">↓</span>
                <span className="sr-only">Move {label} {index + 1} down</span>
              </button>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
                className="inline-flex size-11 items-center justify-center rounded-control border border-blue-300 text-stamp-red-text"
              >
                <IconMinus size={16} />
                <span className="sr-only">Remove {label} {index + 1}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange([...items, ""])}
        >
          <IconPlus size={15} />
          {addLabel}
        </Button>
      </div>
    </fieldset>
  );
}

/** Label-and-value rows, for specifications entered by hand. */
export function PairEditor({
  label,
  hint,
  items,
  onChange,
}: {
  label: string;
  hint?: string;
  items: { label: string; value: string }[];
  onChange: (items: { label: string; value: string }[]) => void;
}) {
  const set = (index: number, patch: Partial<{ label: string; value: string }>) => {
    const next = [...items];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="text-meta font-medium text-ink">{label}</legend>
      {hint ? <p className="text-meta text-ink/70">{hint}</p> : null}

      <ul className="flex flex-col gap-2">
        {items.map((item, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2">
            <input
              value={item.label}
              placeholder="Weight"
              aria-label={`${label} ${index + 1} name`}
              onChange={(event) => set(index, { label: event.target.value })}
              className={`${inputClass} min-w-0 flex-1`}
            />
            <input
              value={item.value}
              placeholder="284 g"
              aria-label={`${label} ${index + 1} value`}
              onChange={(event) => set(index, { value: event.target.value })}
              className={`${inputClass} min-w-0 flex-1`}
            />
            <button
              type="button"
              onClick={() => onChange(items.filter((_, i) => i !== index))}
              className="inline-flex size-11 items-center justify-center rounded-control border border-blue-300 text-stamp-red-text"
            >
              <IconMinus size={16} />
              <span className="sr-only">Remove row {index + 1}</span>
            </button>
          </li>
        ))}
      </ul>

      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange([...items, { label: "", value: "" }])}
        >
          <IconPlus size={15} />
          Add a row
        </Button>
      </div>
    </fieldset>
  );
}

/** Drops blank lines, and returns null when nothing is left. */
export function cleanList(items: string[]): string[] | null {
  const kept = items.map((item) => item.trim()).filter(Boolean);
  return kept.length > 0 ? kept : null;
}

/** An empty string means "clear this field", which the API reads as null. */
export function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
