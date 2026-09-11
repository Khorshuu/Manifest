"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { IconAlert, IconTruck } from "@/components/icons";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";

export type BookAddress = {
  id: string;
  label: string | null;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  district: string;
  postalCode: string | null;
  isDefault: boolean;
};

function AddressForm({
  initial,
  submitLabel,
  onDone,
  onCancel,
}: {
  initial?: BookAddress;
  submitLabel: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const prefix = initial?.id ?? "new";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const optional = (name: string) => text(name) || undefined;

    setPending(true);
    setError(null);
    const response = await fetch(
      initial ? `/api/account/addresses/${initial.id}` : "/api/account/addresses",
      {
        method: initial ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: optional("label"),
          recipientName: text("recipientName"),
          phone: text("phone"),
          addressLine1: text("addressLine1"),
          addressLine2: optional("addressLine2"),
          city: text("city"),
          district: text("district"),
          postalCode: optional("postalCode"),
          makeDefault: form.get("makeDefault") === "on" || undefined,
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field id={`${prefix}-label`} name="label" label="Label" hint="Home, work — optional." defaultValue={initial?.label ?? ""} />
      <Field id={`${prefix}-recipientName`} name="recipientName" label="Recipient" required autoComplete="name" defaultValue={initial?.recipientName ?? ""} />
      <Field id={`${prefix}-phone`} name="phone" label="Phone" type="tel" required autoComplete="tel" defaultValue={initial?.phone ?? ""} />
      <Field id={`${prefix}-addressLine1`} name="addressLine1" label="Street address" required autoComplete="address-line1" defaultValue={initial?.addressLine1 ?? ""} />
      <Field id={`${prefix}-addressLine2`} name="addressLine2" label="Flat, floor, landmark" autoComplete="address-line2" defaultValue={initial?.addressLine2 ?? ""} />
      <Field id={`${prefix}-city`} name="city" label="City or area" required autoComplete="address-level2" defaultValue={initial?.city ?? ""} />
      <Field id={`${prefix}-district`} name="district" label="District" required autoComplete="address-level1" defaultValue={initial?.district ?? ""} />
      <Field id={`${prefix}-postalCode`} name="postalCode" label="Postcode" autoComplete="postal-code" defaultValue={initial?.postalCode ?? ""} />

      {!initial?.isDefault ? (
        <label className="flex min-h-11 items-center gap-2 text-meta text-ink sm:col-span-2">
          <input type="checkbox" name="makeDefault" className="size-4" />
          Use this address by default at checkout
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2" aria-live="polite">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        {error ? (
          <p className="flex items-center gap-2 text-meta text-stamp-red-text">
            <IconAlert size={16} />
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function AddressBook({
  addresses,
  max,
}: {
  addresses: BookAddress[];
  max: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = () => {
    setEditing(null);
    router.refresh();
  };

  async function act(id: string, action: "default" | "remove") {
    if (action === "remove" && !window.confirm("Remove this address from your account?")) {
      return;
    }
    setPending(id);
    setError(null);
    const response = await fetch(`/api/account/addresses/${id}`, {
      method: action === "remove" ? "DELETE" : "PATCH",
      headers: { "content-type": "application/json" },
      body: action === "remove" ? undefined : JSON.stringify({ makeDefault: true }),
    });
    const body = await response.json().catch(() => ({}));
    setPending(null);
    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {addresses.length === 0 && editing !== "new" ? (
        <EmptyState
          icon={<IconTruck size={26} />}
          title="No saved addresses"
          body="Add one here, or tick nothing at all — an address you enter at checkout is saved to your account automatically."
        />
      ) : null}

      <ul className="grid gap-4 sm:grid-cols-2">
        {addresses.map((address) => (
          <li key={address.id} className={editing === address.id ? "sm:col-span-2" : ""}>
            <Panel depth="raised" className={`h-full p-5 ${pending === address.id ? "opacity-70" : ""}`}>
              {editing === address.id ? (
                <AddressForm
                  initial={address}
                  submitLabel="Save address"
                  onDone={done}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex h-full flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-display text-h3 text-ink">
                      {address.label || address.recipientName}
                    </p>
                    {address.isDefault ? <StatusBadge tone="positive">Default</StatusBadge> : null}
                  </div>
                  <address className="text-meta not-italic text-ink/70">
                    {address.recipientName}
                    <br />
                    {address.addressLine1}
                    {address.addressLine2 ? (
                      <>
                        <br />
                        {address.addressLine2}
                      </>
                    ) : null}
                    <br />
                    {address.city}, {address.district}
                    {address.postalCode ? ` ${address.postalCode}` : ""}
                    <br />
                    {address.phone}
                  </address>
                  <div className="mt-auto flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(address.id)}>
                      Edit
                    </Button>
                    {!address.isDefault ? (
                      <Button type="button" variant="quiet" size="sm" disabled={pending === address.id} onClick={() => act(address.id, "default")}>
                        Make default
                      </Button>
                    ) : null}
                    <Button type="button" variant="quiet" size="sm" disabled={pending === address.id} onClick={() => act(address.id, "remove")}>
                      Remove
                    </Button>
                  </div>
                </div>
              )}
            </Panel>
          </li>
        ))}
      </ul>

      {editing === "new" ? (
        <Panel depth="raised" className="p-5">
          <h2 className="mb-4 font-display text-h3 text-ink">New address</h2>
          <AddressForm submitLabel="Add address" onDone={done} onCancel={() => setEditing(null)} />
        </Panel>
      ) : addresses.length < max ? (
        <div>
          <Button type="button" variant="secondary" onClick={() => setEditing("new")}>
            Add an address
          </Button>
        </div>
      ) : (
        <p className="text-meta text-ink/70">
          You have {max} addresses saved, which is the most an account keeps. Remove one to add another.
        </p>
      )}

      <div aria-live="polite">
        {error ? (
          <p className="flex items-center gap-2 text-meta text-stamp-red-text">
            <IconAlert size={16} />
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
