"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { StatusBadge } from "@/components/status-badge";
import { formatBdt } from "@/lib/money";

type Attribute = { id: string; name: string; valueCount: number };

type Variant = {
  id: string;
  sku: string;
  label: string;
  priceBdt: number;
  isEnabled: boolean;
  fulfillmentMode: string;
  preorderCapacity: number | null;
  preorderReserved: number;
};

export function VariantMatrix({
  productId,
  attributes,
  selectedAttributeIds,
  variants,
}: {
  productId: string;
  attributes: Attribute[];
  selectedAttributeIds: string[];
  variants: Variant[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(selectedAttributeIds);
  const [checked, setChecked] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const projected = selected.reduce((total, id) => {
    const attribute = attributes.find((a) => a.id === id);
    return total * (attribute?.valueCount ?? 0);
  }, selected.length > 0 ? 1 : 0);

  async function generate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);

    const form = new FormData(event.currentTarget);
    const takaValue = Number(form.get("priceBdt") ?? 0);

    const response = await fetch("/api/admin/variants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId,
        attributeIds: selected,
        // The form collects taka; the server stores paisa.
        priceBdt: Math.round(takaValue * 100),
        fulfillmentMode: form.get("fulfillmentMode"),
      }),
    });

    const body = await response.json().catch(() => ({}));
    setPending(false);

    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage(
      `${body.result.created} created, ${body.result.unchanged} left as they were` +
        (body.result.orphaned > 0
          ? `, ${body.result.orphaned} no longer match the current attributes and were kept`
          : ""),
    );
    router.refresh();
  }

  async function applyToChecked(update: Record<string, unknown>) {
    if (checked.length === 0) return;
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/admin/variants", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variantIds: checked, update }),
    });

    const body = await response.json().catch(() => ({}));
    setPending(false);

    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage(`${body.updated} variant${body.updated === 1 ? "" : "s"} updated.`);
    setChecked([]);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h2 className="font-display text-h2 text-ink">Attributes</h2>
        <p className="max-w-[70ch] text-body text-ink/80">
          Choose what this product varies by, then generate the combinations.
          Variants that already exist keep their price and capacity.
        </p>

        <form onSubmit={generate} className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-meta font-medium text-ink">
              Vary by
            </legend>
            {attributes.length === 0 ? (
              <p className="text-body text-ink/70">
                No attributes defined yet. Add one before generating variants.
              </p>
            ) : (
              attributes.map((attribute) => (
                <label
                  key={attribute.id}
                  className="flex items-center gap-3 text-body text-ink"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(attribute.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, attribute.id]
                          : current.filter((id) => id !== attribute.id),
                      )
                    }
                    className="size-5"
                  />
                  {attribute.name}
                  <span className="text-meta text-ink/60">
                    {attribute.valueCount} value
                    {attribute.valueCount === 1 ? "" : "s"}
                  </span>
                </label>
              ))
            )}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label htmlFor="priceBdt" className="text-meta font-medium text-ink">
                Starting price (৳)
              </label>
              <input
                id="priceBdt"
                name="priceBdt"
                type="number"
                min={0}
                step="1"
                defaultValue={0}
                className="min-h-11 rounded-control border border-blue-300 px-3 text-body tabular-nums"
              />
              <p className="text-meta text-ink/70">
                Applied to newly created variants only.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <label
                htmlFor="fulfillmentMode"
                className="text-meta font-medium text-ink"
              >
                Sold as
              </label>
              <select
                id="fulfillmentMode"
                name="fulfillmentMode"
                defaultValue="preorder"
                className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
              >
                <option value="preorder">Preorder</option>
                <option value="in_stock">In stock</option>
              </select>
            </div>
          </div>

          <p className="text-meta text-ink/70">
            {projected > 0
              ? `This would cover ${projected} combination${projected === 1 ? "" : "s"}.`
              : "Select at least one attribute."}
          </p>

          <div aria-live="polite" className="flex flex-col gap-1">
            {error ? <p className="text-meta text-stamp-red">{error}</p> : null}
            {message ? (
              <p className="text-meta text-transit-green">{message}</p>
            ) : null}
          </div>

          <div>
            <Button type="submit" disabled={pending || selected.length === 0}>
              {pending ? "Working…" : "Generate variants"}
            </Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-h2 text-ink">
            Variants{" "}
            <span className="text-meta text-ink/60">({variants.length})</span>
          </h2>

          {checked.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => applyToChecked({ isEnabled: false })}
              >
                Disable {checked.length}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => applyToChecked({ isEnabled: true })}
              >
                Enable {checked.length}
              </Button>
            </div>
          ) : null}
        </div>

        {variants.length === 0 ? (
          <p className="text-body text-ink/70">
            No variants yet. Generate them from the attributes above.
          </p>
        ) : (
          <div className="overflow-x-auto border border-blue-300">
            <table className="w-full min-w-[720px] border-collapse text-body">
              <thead>
                <tr className="text-left">
                  <th scope="col" className="px-4 py-3 text-meta font-medium">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col" className="px-4 py-3 text-meta font-medium">
                    Variant
                  </th>
                  <th scope="col" className="px-4 py-3 text-meta font-medium">
                    SKU
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-meta font-medium"
                  >
                    Price
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-meta font-medium"
                  >
                    Capacity
                  </th>
                  <th scope="col" className="px-4 py-3 text-meta font-medium">
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {variants.map((variant, index) => (
                  <tr
                    key={variant.id}
                    className={index % 2 === 1 ? "bg-blue-200/40" : undefined}
                  >
                    <td className="border-t border-blue-300 px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${variant.label}`}
                        checked={checked.includes(variant.id)}
                        onChange={(event) =>
                          setChecked((current) =>
                            event.target.checked
                              ? [...current, variant.id]
                              : current.filter((id) => id !== variant.id),
                          )
                        }
                        className="size-5"
                      />
                    </td>
                    <td className="border-t border-blue-300 px-4 py-3 text-ink">
                      {variant.label}
                    </td>
                    <td className="border-t border-blue-300 px-4 py-3 font-mono text-meta text-ink/70">
                      {variant.sku}
                    </td>
                    <td className="border-t border-blue-300 px-4 py-3 text-right tabular-nums">
                      {formatBdt(variant.priceBdt)}
                    </td>
                    <td className="border-t border-blue-300 px-4 py-3 text-right tabular-nums">
                      {variant.preorderCapacity === null
                        ? "—"
                        : `${variant.preorderReserved} / ${variant.preorderCapacity}`}
                    </td>
                    <td className="border-t border-blue-300 px-4 py-3">
                      <StatusBadge
                        tone={variant.isEnabled ? "positive" : "negative"}
                      >
                        {variant.isEnabled ? "Enabled" : "Disabled"}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
