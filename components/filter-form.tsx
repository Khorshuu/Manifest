"use client";

import Form from "next/form";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * The filter panel's form: an ordinary GET form that navigates without
 * reloading the page, so the header, the search box and the scroll position
 * survive a filter.
 *
 * Every filter applies the moment it is chosen, at every width — there is no
 * Apply button. A tick, a radio or a price band navigates at once; the two
 * price fields wait until typing pauses, so a four-digit price is one request
 * rather than four. On a phone the sheet stays open while filters are chosen,
 * with the running result count at its foot. With JavaScript off it is still
 * a form, submitted with Enter.
 *
 * Its inputs are uncontrolled, so they are put back in step with the address
 * whenever it changes — removing a chip, pressing back — without remounting
 * anything, which would throw away the keyboard focus of someone working
 * through the list.
 *
 * Empty fields are left out of the address, so a filtered listing reads
 * `?brand=Acme` rather than `?brand=Acme&min=&max=&fulfillment=`.
 */
export function FilterForm({
  action,
  children,
}: {
  action: string;
  children: ReactNode;
}) {
  const params = useSearchParams();
  const ref = useRef<HTMLFormElement>(null);
  const typing = useRef<number | null>(null);

  useEffect(() => {
    const form = ref.current;
    if (!form) return;

    for (const element of Array.from(form.elements)) {
      if (!(element instanceof HTMLInputElement) || !element.name) continue;
      // Leave a field alone while someone is typing in it.
      if (element === document.activeElement && element.type === "number") continue;

      if (element.type === "checkbox") {
        element.checked = params.getAll(element.name).includes(element.value);
      } else if (element.type === "radio") {
        element.checked = (params.get(element.name) ?? "") === element.value;
      } else if (element.type === "number" || element.type === "text") {
        element.value = params.get(element.name) ?? "";
      }
    }
  }, [params]);

  useEffect(
    () => () => {
      if (typing.current) window.clearTimeout(typing.current);
    },
    [],
  );

  return (
    <Form
      ref={ref}
      action={action}
      scroll={false}
      aria-label="Filter products"
      className="min-w-0"
      onSubmit={(event) => {
        const form = event.currentTarget;
        const empty = Array.from(form.elements).filter(
          (element): element is HTMLInputElement =>
            element instanceof HTMLInputElement &&
            Boolean(element.name) &&
            !element.disabled &&
            element.value === "" &&
            (element.type !== "radio" || element.checked),
        );

        for (const element of empty) element.disabled = true;
        // Re-enabled once the navigation has read the form.
        window.setTimeout(() => {
          for (const element of empty) element.disabled = false;
        }, 0);
      }}
      onChange={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.id === "filter-drawer") return;
        if (target.type !== "checkbox" && target.type !== "radio") return;
        event.currentTarget.requestSubmit();
      }}
      onInput={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== "number") return;
        const form = event.currentTarget;
        if (typing.current) window.clearTimeout(typing.current);
        typing.current = window.setTimeout(() => form.requestSubmit(), 700);
      }}
    >
      {children}
    </Form>
  );
}
