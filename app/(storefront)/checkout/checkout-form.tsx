"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import {
  IconAlert,
  IconCheck,
  IconSeal,
  IconShield,
} from "@/components/icons";
import { Panel } from "@/components/panel";
import { ProductArt } from "@/components/product-art";
import { formatBdt } from "@/lib/money";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/providers/payment";

export type CheckoutSummary = {
  subtotalBdt: number;
  dueNowBdt: number;
  lineCount: number;
  /** Cash on delivery is not offered when the order contains a preorder. */
  codAllowed: boolean;
};

export type SavedAddress = {
  id: string;
  label: string;
};

export type CheckoutLine = {
  itemId: string;
  title: string;
  optionSummary: string;
  /** Named pairs — "Colour: Pearl White" — so nobody pays for a guess. */
  options: { label: string; value: string }[];
  sku: string;
  unitPriceBdt: number;
  quantity: number;
  lineTotalBdt: number;
  imageUrl: string | null;
  slug: string;
};

const methodOrder: PaymentMethod[] = [
  "bkash",
  "nagad",
  "rocket",
  "card",
  "bank_transfer",
  "cod",
];

/** One sentence per method, so a shopper picks on information rather than habit. */
const methodNotes: Partial<Record<PaymentMethod, string>> = {
  bkash: "Mobile wallet",
  nagad: "Mobile wallet",
  rocket: "Mobile wallet",
  card: "Visa or Mastercard",
  bank_transfer: "We send account details",
  cod: "Pay the courier at your door",
};

/**
 * A numbered section of the form.
 *
 * The whole form used to be three unadorned `h2`s in a column, which made a
 * five-minute task look like a twenty-minute one. Numbering it and boxing each
 * part gives the same fields an obvious end.
 */
function Step({
  index,
  title,
  children,
  note,
}: {
  index: number;
  title: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <Panel depth="raised" className="p-5 sm:p-6">
      <div className="flex items-baseline gap-3">
        <span
          aria-hidden="true"
          className="font-display text-h3 tabular-nums text-brass-text"
        >
          {String(index).padStart(2, "0")}
        </span>
        <h2 className="font-display text-h2 text-ink">{title}</h2>
      </div>

      {note ? <p className="mt-2 text-meta text-ink/70">{note}</p> : null}

      <div className="mt-5 flex flex-col gap-5">{children}</div>
    </Panel>
  );
}

export function CheckoutForm({
  summary,
  savedAddresses,
  defaultEmail,
  lines,
}: {
  summary: CheckoutSummary;
  savedAddresses: SavedAddress[];
  defaultEmail: string;
  lines: CheckoutLine[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [useSaved, setUseSaved] = useState(savedAddresses.length > 0);
  const [method, setMethod] = useState<PaymentMethod>("bkash");
  const errorRef = useRef<HTMLDivElement>(null);

  /**
   * Generated once per mounted form. A double submit, or a retry after a
   * timeout, sends the same key and cannot create a second order.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  /*
   * A failed submit moves focus to the message. The error sits beside the
   * button on a wide screen and below the whole form on a phone, so without
   * this someone on a keyboard or a screen reader presses "Place order" and
   * appears to get nothing at all.
   */
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);

    const payload: Record<string, unknown> = {
      method,
      email: form.get("email"),
      phone: form.get("phone") || undefined,
      idempotencyKey,
    };

    if (useSaved && form.get("shippingAddressId")) {
      payload.shippingAddressId = form.get("shippingAddressId");
    } else {
      payload.address = {
        recipientName: form.get("recipientName"),
        phone: form.get("addressPhone"),
        addressLine1: form.get("addressLine1"),
        addressLine2: form.get("addressLine2") || undefined,
        city: form.get("city"),
        district: form.get("district"),
        postalCode: form.get("postalCode") || undefined,
      };
    }

    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    router.push(`/checkout/confirmation?order=${body.order.orderNumber}`);
    router.refresh();
  }

  const balance = summary.subtotalBdt - summary.dueNowBdt;

  return (
    <form
      onSubmit={onSubmit}
      className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-12"
    >
      <div className="flex min-w-0 flex-col gap-5">
        <Step index={1} title="Contact" note="Where your confirmation goes.">
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={defaultEmail}
            hint="We send your order confirmation and updates here."
          />
          <Field label="Phone" name="phone" type="tel" autoComplete="tel" />
        </Step>

        <Step index={2} title="Delivery address">
          {savedAddresses.length > 0 ? (
            <div className="flex flex-col gap-3">
              <label
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-control border px-4 text-body transition-colors ${
                  useSaved
                    ? "border-blue-600 bg-blue-50 text-ink"
                    : "border-blue-300 text-ink hover:border-blue-500"
                }`}
              >
                <input
                  type="radio"
                  name="addressChoice"
                  checked={useSaved}
                  onChange={() => setUseSaved(true)}
                  className="size-5"
                />
                Use a saved address
              </label>

              {useSaved ? (
                <div className="flex flex-col gap-2 pl-4">
                  <label htmlFor="shippingAddressId" className="sr-only">
                    Saved address
                  </label>
                  <select
                    id="shippingAddressId"
                    name="shippingAddressId"
                    className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
                  >
                    {savedAddresses.map((address) => (
                      <option key={address.id} value={address.id}>
                        {address.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <label
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-control border px-4 text-body transition-colors ${
                  !useSaved
                    ? "border-blue-600 bg-blue-50 text-ink"
                    : "border-blue-300 text-ink hover:border-blue-500"
                }`}
              >
                <input
                  type="radio"
                  name="addressChoice"
                  checked={!useSaved}
                  onChange={() => setUseSaved(false)}
                  className="size-5"
                />
                Enter a new address
              </label>
            </div>
          ) : null}

          {!useSaved ? (
            <div className="flex flex-col gap-5">
              <Field
                label="Recipient name"
                name="recipientName"
                autoComplete="name"
                required
              />
              <Field
                label="Phone for delivery"
                name="addressPhone"
                type="tel"
                autoComplete="tel"
                required
              />
              <Field
                label="Address"
                name="addressLine1"
                autoComplete="address-line1"
                required
              />
              <Field
                label="Area or apartment"
                name="addressLine2"
                autoComplete="address-line2"
              />
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="City"
                  name="city"
                  autoComplete="address-level2"
                  required
                />
                <Field
                  label="District"
                  name="district"
                  autoComplete="address-level1"
                  required
                />
              </div>
              <Field
                label="Postal code"
                name="postalCode"
                autoComplete="postal-code"
                inputMode="numeric"
              />
            </div>
          ) : null}
        </Step>

        <Step index={3} title="Payment">
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">Payment method</legend>
            {methodOrder
              .filter((option) => option !== "cod" || summary.codAllowed)
              .map((option) => {
                const selected = method === option;

                return (
                  <label
                    key={option}
                    /*
                     * The input itself is visually hidden so the card can be
                     * the control, which means the label has to carry the
                     * focus ring — otherwise a keyboard moving through the
                     * methods would move through nothing visible at all.
                     */
                    className={`relative flex min-h-14 cursor-pointer items-center gap-3 rounded-control border px-4 py-2.5 transition-[border-color,background-color,box-shadow] duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brass ${
                      selected
                        ? "border-blue-600 bg-blue-50 shadow-[var(--shadow-raise)]"
                        : "border-blue-300 hover:border-blue-500 hover:bg-blue-50/60"
                    }`}
                  >
                    <input
                      type="radio"
                      name="method"
                      value={option}
                      checked={selected}
                      onChange={() => setMethod(option)}
                      /* Transparent rather than hidden: an `sr-only` input has
                         no box to click, so the radio stopped being operable
                         as a radio even though the card still worked. */
                      className="absolute inset-0 m-0 size-full cursor-pointer appearance-none opacity-0"
                    />

                    {/* The selected mark is a shape as well as a colour, so
                        the choice is not carried by blue alone. */}
                    <span
                      aria-hidden="true"
                      className={`inline-flex size-5 shrink-0 items-center justify-center rounded-card border ${
                        selected
                          ? "border-blue-600 bg-blue-600 text-paper"
                          : "border-blue-400"
                      }`}
                    >
                      {selected ? <IconCheck size={12} /> : null}
                    </span>

                    <span className="min-w-0">
                      <span
                        className={`block text-body ${
                          selected ? "font-medium text-ink" : "text-ink"
                        }`}
                      >
                        {PAYMENT_METHOD_LABELS[option]}
                      </span>
                      {methodNotes[option] ? (
                        <span className="block text-meta text-ink/70">
                          {methodNotes[option]}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
          </fieldset>

          {!summary.codAllowed ? (
            <p className="flex items-start gap-2 rounded-card border border-blue-300 bg-blue-50 p-3 text-meta text-ink/70">
              <IconSeal size={18} className="mt-px shrink-0 text-blue-500" />
              Cash on delivery is not available for preorders — the payment
              funds the purchase in the United States.
            </p>
          ) : null}
        </Step>
      </div>

      <Panel
        as="aside"
        depth="float"
        className="h-fit p-5 sm:p-6 lg:sticky lg:top-28"
      >
        <h2 className="font-display text-h2 text-ink">Order summary</h2>

        {/* What is being bought, not only what it costs. Someone three fields
            into an address form should not have to go back to check. */}
        <ul className="mt-4 flex flex-col gap-3 border-b border-blue-200 pb-4">
          {lines.map((line) => (
            <li key={line.itemId} className="flex items-start gap-3">
              <Link
                href={`/products/${line.slug}`}
                tabIndex={-1}
                aria-hidden="true"
                className="surface-studio size-12 shrink-0 overflow-hidden rounded-card border border-blue-300"
              >
                {line.imageUrl ? (
                  /* Placeholder media until the storage integration lands. */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={line.imageUrl} alt="" className="size-full object-cover" />
                ) : (
                  <ProductArt
                    title={line.title}
                    seed={line.slug}
                    className="size-full"
                  />
                )}
              </Link>

              {/*
                Exactly what is being paid for, before the order is placed:
                every option by name, the quantity and the unit price. A line
                that reads only "Sofa" is the complaint this answers (D-043).
              */}
              <div className="min-w-0 flex-1">
                <p className="text-meta font-medium text-ink">{line.title}</p>
                {line.options.length > 0 ? (
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {line.options.map((option) => (
                      <li
                        key={`${option.label}-${option.value}`}
                        className="text-meta text-ink/70"
                      >
                        <span className="text-ink/55">{option.label}: </span>
                        {option.value}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-0.5 text-meta tabular-nums text-ink/70">
                  {line.quantity} × {formatBdt(line.unitPriceBdt)}
                </p>
              </div>

              <p className="shrink-0 text-meta tabular-nums text-ink">
                {formatBdt(line.lineTotalBdt)}
              </p>
            </li>
          ))}
        </ul>

        <dl className="mt-4 flex flex-col gap-3 text-body">
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">
              {summary.lineCount} item{summary.lineCount === 1 ? "" : "s"}
            </dt>
            <dd className="tabular-nums text-ink">
              {formatBdt(summary.subtotalBdt)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink/70">Shipping and duty</dt>
            <dd className="text-transit-green-text">Included</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-blue-300 pt-4">
            <dt className="font-medium text-ink">Due now</dt>
            <dd className="font-display text-h2 font-semibold tabular-nums text-ink">
              {formatBdt(summary.dueNowBdt)}
            </dd>
          </div>
        </dl>

        {balance > 0 ? (
          <p className="mt-3 text-meta text-ink/70">
            The balance of {formatBdt(balance)} is collected once your items are
            bought in the US.
          </p>
        ) : null}

        <div aria-live="polite">
          {error ? (
            <div
              ref={errorRef}
              tabIndex={-1}
              className="mt-4 flex items-start gap-2 rounded-card border border-stamp-red bg-stamp-red/5 p-3 text-meta text-stamp-red-text"
            >
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div className="mt-5">
          <Button
            type="submit"
            size="lg"
            disabled={pending}
            className="w-full"
          >
            {pending ? "Placing your order…" : "Place order"}
          </Button>
        </div>

        <p className="mt-4 flex items-start gap-2.5 text-meta text-ink/70">
          <IconShield size={18} className="mt-px shrink-0 text-blue-500" />
          Nothing further is charged on delivery. Cancel for a full refund until
          we place the US order.
        </p>
      </Panel>
    </form>
  );
}
