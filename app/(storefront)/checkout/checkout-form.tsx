"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
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

const methodOrder: PaymentMethod[] = [
  "bkash",
  "nagad",
  "rocket",
  "card",
  "bank_transfer",
  "cod",
];

export function CheckoutForm({
  summary,
  savedAddresses,
  defaultEmail,
}: {
  summary: CheckoutSummary;
  savedAddresses: SavedAddress[];
  defaultEmail: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [useSaved, setUseSaved] = useState(savedAddresses.length > 0);
  const [method, setMethod] = useState<PaymentMethod>("bkash");

  /**
   * Generated once per mounted form. A double submit, or a retry after a
   * timeout, sends the same key and cannot create a second order.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID());

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

  return (
    <form
      onSubmit={onSubmit}
      className="grid items-start gap-10 lg:grid-cols-[1fr_360px]"
    >
      <div className="flex min-w-0 flex-col gap-8">
        <section className="flex flex-col gap-5">
          <h2 className="font-display text-h2 text-ink">Contact</h2>
          <Field
            label="Email"
            name="email"
            type="email"
            required
            defaultValue={defaultEmail}
            hint="We send your order confirmation and updates here."
          />
          <Field label="Phone" name="phone" type="tel" />
        </section>

        <section className="flex flex-col gap-5">
          <h2 className="font-display text-h2 text-ink">Delivery address</h2>

          {savedAddresses.length > 0 ? (
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-3 text-body text-ink">
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
                <div className="flex flex-col gap-2 pl-8">
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

              <label className="flex items-center gap-3 text-body text-ink">
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
              <Field label="Recipient name" name="recipientName" required />
              <Field label="Phone for delivery" name="addressPhone" required />
              <Field label="Address" name="addressLine1" required />
              <Field label="Area or apartment" name="addressLine2" />
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="City" name="city" required />
                <Field label="District" name="district" required />
              </div>
              <Field label="Postal code" name="postalCode" />
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="font-display text-h2 text-ink">Payment</h2>

          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">Payment method</legend>
            {methodOrder
              .filter((option) => option !== "cod" || summary.codAllowed)
              .map((option) => (
                <label
                  key={option}
                  className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-control border px-3 text-body ${
                    method === option
                      ? "border-blue-600 text-blue-600"
                      : "border-blue-300 text-ink"
                  }`}
                >
                  <input
                    type="radio"
                    name="method"
                    value={option}
                    checked={method === option}
                    onChange={() => setMethod(option)}
                    className="size-5"
                  />
                  {PAYMENT_METHOD_LABELS[option]}
                </label>
              ))}
          </fieldset>

          {!summary.codAllowed ? (
            <p className="text-meta text-ink/70">
              Cash on delivery is not available for preorders — the payment
              funds the purchase in the United States.
            </p>
          ) : null}
        </section>
      </div>

      <aside className="h-fit border border-blue-300 p-5">
        <h2 className="font-display text-h2 text-ink">Order summary</h2>

        <dl className="mt-4 flex flex-col gap-2 text-body">
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
            <dd className="text-ink">Included</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-blue-300 pt-3">
            <dt className="font-medium text-ink">Due now</dt>
            <dd className="text-price font-semibold tabular-nums text-ink">
              {formatBdt(summary.dueNowBdt)}
            </dd>
          </div>
        </dl>

        {summary.dueNowBdt !== summary.subtotalBdt ? (
          <p className="mt-3 text-meta text-ink/70">
            The balance of{" "}
            {formatBdt(summary.subtotalBdt - summary.dueNowBdt)} is collected
            once your items are bought in the US.
          </p>
        ) : null}

        <div aria-live="polite">
          {error ? (
            <p className="mt-4 text-meta text-stamp-red-text">{error}</p>
          ) : null}
        </div>

        <div className="mt-5">
          <Button type="submit" disabled={pending}>
            {pending ? "Placing your order…" : "Place order"}
          </Button>
        </div>

        <p className="mt-3 text-meta text-ink/70">
          Nothing further is charged on delivery.
        </p>
      </aside>
    </form>
  );
}
