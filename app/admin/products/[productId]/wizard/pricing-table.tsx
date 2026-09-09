"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

export type PricingVariant = {
  id: string;
  sku: string;
  label: string;
  priceTaka: string;
  fulfillmentMode: string;
  stockQuantity: number | null;
  preorderCapacity: number | null;
  preorderReserved: number;
  /** ISO date, yyyy-mm-dd, for the date inputs. */
  closesAt: string;
  arrivesFrom: string;
  arrivesTo: string;
  paymentMode: string;
  depositPercent: number | null;
};

type RowState = {
  saving: boolean;
  error: string | null;
  saved: boolean;
};

/**
 * Price, capacity and terms per variant.
 *
 * Each row saves on its own, so a mistake in one line does not throw away the
 * work done in the others — this is a table someone fills in over several
 * minutes with a supplier invoice beside them. Capacity below what is already
 * reserved is refused by the server, and the reason is shown on the row.
 */
export function PricingTable({
  variants,
  nextHref,
}: {
  variants: PricingVariant[];
  nextHref: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  function setRow(id: string, state: Partial<RowState>) {
    setRows((current) => ({
      ...current,
      [id]: {
        ...{ saving: false, error: null, saved: false },
        ...current[id],
        ...state,
      },
    }));
  }

  function readRow(form: HTMLFormElement) {
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const number = (name: string) => {
      const raw = text(name);
      return raw === "" ? null : Number(raw);
    };
    const date = (name: string) => {
      const raw = text(name);
      return raw === "" ? null : new Date(`${raw}T00:00:00Z`).toISOString();
    };

    const fulfillmentMode = text("fulfillmentMode");
    const paymentMode = text("paymentMode");

    return {
      // Taka in the form, paisa in the database — the one conversion point.
      priceBdt: Math.round(Number(text("priceTaka") || 0) * 100),
      fulfillmentMode: fulfillmentMode === "in_stock" ? "in_stock" : "preorder",
      stockQuantity: fulfillmentMode === "in_stock" ? number("stockQuantity") : null,
      preorderCapacity:
        fulfillmentMode === "preorder" ? number("preorderCapacity") : null,
      preorderClosesAt: fulfillmentMode === "preorder" ? date("closesAt") : null,
      estimatedArrivalFrom: date("arrivesFrom"),
      estimatedArrivalTo: date("arrivesTo"),
      paymentMode: paymentMode === "deposit" ? "deposit" : "full",
      depositPercent:
        paymentMode === "deposit" ? number("depositPercent") : null,
    };
  }

  async function saveRow(id: string, event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRow(id, { saving: true, error: null, saved: false });

    const response = await fetch(`/api/admin/variants/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(readRow(event.currentTarget)),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setRow(id, {
        saving: false,
        error: body.error ?? "Something went wrong. Try again.",
      });
      return;
    }

    setRow(id, { saving: false, saved: true });
    router.refresh();
  }

  /** Applies one price to every variant, for the common flat-priced case. */
  async function applyPriceToAll(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBulkPending(true);
    setBulkError(null);

    const taka = Number(
      String(new FormData(event.currentTarget).get("bulkPrice") ?? "0"),
    );

    const response = await fetch("/api/admin/variants", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        variantIds: variants.map((variant) => variant.id),
        update: { priceBdt: Math.round(taka * 100) },
      }),
    });

    setBulkPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setBulkError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    router.refresh();
  }

  if (variants.length === 0) {
    return (
      <div className="rounded-card border border-blue-300 bg-paper p-6 shadow-[var(--shadow-raise)]">
        <p className="text-body text-ink">There is nothing to price yet.</p>
        <p className="mt-2 text-meta text-ink/70">
          Go back a step and generate the variants first.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <form
        onSubmit={applyPriceToAll}
        className="flex flex-wrap items-end gap-3 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="bulkPrice" className="text-meta font-medium text-ink">
            One price for all {variants.length} variants (BDT)
          </label>
          <input
            id="bulkPrice"
            name="bulkPrice"
            type="number"
            min={0}
            step="0.01"
            className="min-h-11 w-40 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={bulkPending}>
          {bulkPending ? "Applying…" : "Apply to all"}
        </Button>
        {bulkError ? (
          <p className="text-meta text-stamp-red-text">{bulkError}</p>
        ) : null}
      </form>

      <ul className="flex flex-col gap-4">
        {variants.map((variant) => {
          const state = rows[variant.id];

          return (
            <li key={variant.id} className="lift min-w-0 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
              <form onSubmit={(event) => saveRow(variant.id, event)} noValidate>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-display text-h3 text-ink">
                    {variant.label}
                  </h3>
                  <p className="font-mono text-meta text-ink/70">{variant.sku}</p>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Price (BDT)
                    <input
                      name="priceTaka"
                      type="number"
                      min={0}
                      step="0.01"
                      required
                      defaultValue={variant.priceTaka}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    />
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Fulfillment
                    <select
                      name="fulfillmentMode"
                      defaultValue={variant.fulfillmentMode}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    >
                      <option value="preorder">Preorder</option>
                      <option value="in_stock">In stock</option>
                    </select>
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Stock on hand
                    <input
                      name="stockQuantity"
                      type="number"
                      min={0}
                      defaultValue={variant.stockQuantity ?? ""}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    />
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Preorder capacity
                    <input
                      name="preorderCapacity"
                      type="number"
                      min={variant.preorderReserved}
                      defaultValue={variant.preorderCapacity ?? ""}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    />
                    <span className="text-meta text-ink/70">
                      {variant.preorderReserved} already reserved
                    </span>
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Preorder closes
                    <input
                      name="closesAt"
                      type="date"
                      defaultValue={variant.closesAt}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    />
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Payment
                    <select
                      name="paymentMode"
                      defaultValue={variant.paymentMode}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    >
                      <option value="full">Pay in full</option>
                      <option value="deposit">Deposit</option>
                    </select>
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Deposit percent
                    <input
                      name="depositPercent"
                      type="number"
                      min={1}
                      max={99}
                      defaultValue={variant.depositPercent ?? ""}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    />
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Arrives from
                    <input
                      name="arrivesFrom"
                      type="date"
                      defaultValue={variant.arrivesFrom}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    />
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-meta text-ink">
                    Arrives to
                    <input
                      name="arrivesTo"
                      type="date"
                      defaultValue={variant.arrivesTo}
                      className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
                    />
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={state?.saving}
                  >
                    {state?.saving ? "Saving…" : "Save this variant"}
                  </Button>

                  <span aria-live="polite" className="text-meta">
                    {state?.error ? (
                      <span className="text-stamp-red-text">{state.error}</span>
                    ) : state?.saved ? (
                      <span className="text-transit-green-text">Saved.</span>
                    ) : null}
                  </span>
                </div>
              </form>
            </li>
          );
        })}
      </ul>

      <div>
        <a
          href={nextHref}
          className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body surface-brass sheen text-ink shadow-[var(--shadow-raise)] hover:shadow-[var(--shadow-brass)] hover:brightness-[1.04]"
        >
          Continue
        </a>
      </div>
    </div>
  );
}
