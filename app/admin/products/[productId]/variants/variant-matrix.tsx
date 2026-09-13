"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { Button } from "@/components/button";
import { StatusBadge } from "@/components/status-badge";
import { formatBdt } from "@/lib/money";

/**
 * Variants, pricing and inventory — one compact section (D-040).
 *
 * Options ("variant groups") belong to this product alone: a new product
 * starts with none, and removing a value here touches only this product.
 * Adding a group or a value creates the missing combinations straight away at
 * the starting price. Every variant is one short row — photo, name, SKU,
 * price, stock — that opens into its editor, so two variants take two lines
 * and ten take ten, with the rest folded away.
 */

export type ManagerOption = { id: string; name: string; values: { id: string; value: string }[] };

export type ManagerVariant = {
  id: string;
  sku: string;
  label: string;
  priceBdt: number;
  salePriceBdt: number | null;
  isEnabled: boolean;
  fulfillmentMode: string;
  stockQuantity: number | null;
  lowStockThreshold: number | null;
  preorderCapacity: number | null;
  preorderReserved: number;
  /** yyyy-mm-dd, empty when unset. */
  closesAt: string;
  arrivesFrom: string;
  arrivesTo: string;
  paymentMode: string;
  depositPercent: number | null;
  archived: boolean;
  imageUrl: string | null;
  imageId: string | null;
};

export type ManagerPhoto = { id: string; url: string; altText: string };

const input =
  "min-h-10 w-full rounded-control border border-blue-300 bg-paper px-2.5 text-meta text-ink";
const label = "flex min-w-0 flex-col gap-1 text-[0.75rem] font-medium text-ink/75";
const VALUES_SHOWN = 6;
const ROWS_SHOWN = 8;

function isoDate(value: string): string | null {
  return value ? new Date(`${value}T00:00:00Z`).toISOString() : null;
}

function stockText(variant: ManagerVariant): string {
  if (variant.fulfillmentMode === "in_stock") return `${variant.stockQuantity ?? 0} in stock`;
  if (variant.preorderCapacity === null) return "Preorder, no limit";
  return `${Math.max(0, variant.preorderCapacity - variant.preorderReserved)} of ${variant.preorderCapacity} places`;
}

function stateOf(variant: ManagerVariant): { text: string; tone: "positive" | "warning" | "negative" | "neutral" } {
  if (variant.archived) return { text: "Archived", tone: "neutral" };
  if (!variant.isEnabled) return { text: "Off", tone: "negative" };
  const left =
    variant.fulfillmentMode === "in_stock"
      ? (variant.stockQuantity ?? 0)
      : variant.preorderCapacity === null
        ? Infinity
        : variant.preorderCapacity - variant.preorderReserved;
  if (left <= 0) return { text: "Out of stock", tone: "negative" };
  const line = variant.fulfillmentMode === "in_stock" ? (variant.lowStockThreshold ?? 3) : 3;
  if (left <= line) return { text: "Low stock", tone: "warning" };
  return { text: "On sale", tone: "positive" };
}

export function VariantMatrix({
  productId,
  productTitle,
  options,
  variants,
  photos,
}: {
  productId: string;
  productTitle: string;
  options: ManagerOption[];
  variants: ManagerVariant[];
  photos: ManagerPhoto[];
}) {
  const router = useRouter();
  const live = variants.filter((variant) => !variant.archived);
  const archivedCount = variants.length - live.length;

  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openVariant, setOpenVariant] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [addingGroup, setAddingGroup] = useState(false);
  const [basePrice, setBasePrice] = useState(live[0] ? String(live[0].priceBdt / 100) : "");
  const [baseMode, setBaseMode] = useState(live[0]?.fulfillmentMode === "in_stock" ? "in_stock" : "preorder");

  const rows = showArchived ? variants : live;
  const visibleRows = showAll ? rows : rows.slice(0, ROWS_SHOWN);

  async function call(url: string, method: string, body?: unknown) {
    const response = await fetch(url, {
      method,
      headers: body instanceof FormData || !body ? undefined : { "content-type": "application/json" },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) {
      setError(json.error ?? "Something went wrong. Try again.");
      return null;
    }
    return json as Record<string, unknown>;
  }

  async function run(work: () => Promise<string | null | undefined>) {
    setPending(true);
    setError(null);
    setMessage(null);
    const done = await work();
    setPending(false);
    if (done) setMessage(done);
    router.refresh();
  }

  /** Creates any missing combinations of the given groups at the starting price. */
  async function generate(optionIds: string[]) {
    const json = await call("/api/admin/variants", "POST", {
      productId,
      attributeIds: optionIds,
      priceBdt: Math.round(Number(basePrice || 0) * 100),
      fulfillmentMode: baseMode,
      // Variants that no longer fit the groups (the plain one once a group
      // exists, one-group ones once a second is added) go, not linger on sale.
      prune: true,
    });
    const result = json?.result as { created: number } | undefined;
    return result ? result.created : null;
  }

  function addGroup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("group") ?? "").trim();
    const values = String(form.get("values") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const formElement = event.currentTarget;
    void run(async () => {
      const json = await call(`/api/admin/products/${productId}/options`, "POST", { name, values });
      const option = json?.option as { id: string } | undefined;
      if (!option) return null;
      formElement.reset();
      setAddingGroup(false);
      const created = await generate([...options.map((entry) => entry.id), option.id]);
      return `“${name}” added${created ? ` — ${created} variant${created === 1 ? "" : "s"} created` : ""}.`;
    });
  }

  function addValue(option: ManagerOption, element: HTMLInputElement) {
    const value = element.value.trim();
    if (!value) return;
    void run(async () => {
      if (!(await call(`/api/admin/attributes/${option.id}/values`, "POST", { value }))) return null;
      element.value = "";
      const created = await generate(options.map((entry) => entry.id));
      return `${option.name}: “${value}” added${created ? ` — ${created} variant${created === 1 ? "" : "s"} created` : ""}.`;
    });
  }

  function removeValue(option: ManagerOption, value: { id: string; value: string }) {
    if (!window.confirm(`Remove “${value.value}” from ${option.name}? Its variants on this product are removed (archived if they were ever ordered). No other product is affected.`)) return;
    void run(async () => {
      const json = await call(`/api/admin/attributes/values/${value.id}`, "DELETE");
      if (!json) return null;
      return `“${value.value}” removed${json.archived ? ` (${json.archived} ordered variant${json.archived === 1 ? "" : "s"} archived)` : ""}.`;
    });
  }

  function removeGroup(option: ManagerOption) {
    if (!window.confirm(`Remove the ${option.name} group? Every variant is rebuilt from the groups that remain, at the starting price.`)) return;
    void run(async () => {
      if (!(await call(`/api/admin/products/${productId}/options/${option.id}`, "DELETE"))) return null;
      await generate(options.filter((entry) => entry.id !== option.id).map((entry) => entry.id));
      return `${option.name} removed.`;
    });
  }

  function samePriceForAll() {
    const price = Math.round(Number(basePrice || 0) * 100);
    if (price <= 0) {
      setError("Enter a price above zero first.");
      return;
    }
    void run(async () => {
      const json = await call("/api/admin/variants", "PATCH", {
        variantIds: live.map((variant) => variant.id),
        update: { priceBdt: price },
      });
      return json ? `All ${live.length} variants now ${formatBdt(price)}.` : null;
    });
  }

  function removeVariants(ids: string[]) {
    if (!window.confirm(`Delete ${ids.length === 1 ? "this variant" : `${ids.length} variants`}? Ordered variants are archived instead, so past orders stay intact.`)) return;
    void run(async () => {
      let deleted = 0;
      let archived = 0;
      for (const id of ids) {
        const json = await call(`/api/admin/variants/${id}`, "DELETE");
        if (!json) return null;
        if (json.mode === "archived") archived += 1;
        else deleted += 1;
      }
      setChecked(new Set());
      setOpenVariant(null);
      return [deleted ? `${deleted} deleted` : "", archived ? `${archived} archived (they have orders)` : ""].filter(Boolean).join(", ") + ".";
    });
  }

  function bulkEnabled(isEnabled: boolean) {
    void run(async () => {
      const json = await call("/api/admin/variants", "PATCH", { variantIds: [...checked], update: { isEnabled } });
      if (!json) return null;
      setChecked(new Set());
      return `${json.updated} variant${json.updated === 1 ? "" : "s"} turned ${isEnabled ? "on" : "off"}.`;
    });
  }

  function toggle(set: Set<string>, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  const single = options.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* ------------------------------------------------ variant groups */}
      <div className="flex flex-col gap-2">
        {single ? (
          <p className="text-meta text-ink/70">
            One version of this product. If it comes in colours, sizes or models, add a variant group.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-blue-200 rounded-card border border-blue-200">
            {options.map((option) => {
              const open = openGroups.has(option.id);
              const shown = open ? option.values : option.values.slice(0, VALUES_SHOWN);
              const hidden = option.values.length - shown.length;
              return (
                <li key={option.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                  <span className="min-w-24 text-meta font-semibold text-ink">
                    {option.name}
                    <span className="ml-1 font-normal text-ink/70">({option.values.length})</span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    {shown.map((value) => (
                      <span key={value.id} className="inline-flex items-center rounded-control border border-blue-200 bg-paper-raised py-0.5 pl-2 pr-0.5 text-[0.75rem] text-ink">
                        {value.value}
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => removeValue(option, value)}
                          className="ml-0.5 inline-flex size-6 items-center justify-center rounded text-ink/70 hover:bg-stamp-red/10 hover:text-stamp-red-text"
                        >
                          <span aria-hidden="true">×</span>
                          <span className="sr-only">Remove {value.value}</span>
                        </button>
                      </span>
                    ))}
                    {hidden > 0 || open ? (
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpenGroups((current) => toggle(current, option.id))}
                        className="text-[0.75rem] font-medium text-blue-600 hover:underline"
                      >
                        {open ? "Show fewer" : `+${hidden} more`}
                      </button>
                    ) : null}
                    <input
                      aria-label={`Add a ${option.name} value`}
                      placeholder="+ Add value"
                      disabled={pending}
                      // Enter only: adding on blur as well submitted the value
                      // twice, because saving disables the field and blurs it.
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addValue(option, event.currentTarget);
                        }
                      }}
                      title="Type a value and press Enter"
                      className="min-h-8 w-28 rounded-control border border-dashed border-blue-300 bg-paper px-2 text-[0.75rem] text-ink placeholder:text-blue-600"
                    />
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => removeGroup(option)}
                    className="text-[0.75rem] text-ink/70 hover:text-stamp-red-text"
                  >
                    Remove group
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {addingGroup ? (
          <form onSubmit={addGroup} className="grid gap-2 rounded-card border border-dashed border-blue-300 bg-paper-raised p-3 sm:grid-cols-[10rem_1fr_auto_auto] sm:items-end">
            <label className={label}>
              Group name
              <input name="group" required autoFocus placeholder="Color" className={input} />
            </label>
            <label className={label}>
              Values, separated by commas
              <input name="values" placeholder="Pearl White, Midnight Black" className={input} />
            </label>
            <Button type="submit" size="sm" disabled={pending}>
              Add group
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={() => setAddingGroup(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div>
            <Button type="button" size="sm" variant="secondary" onClick={() => setAddingGroup(true)}>
              + Add variant group
            </Button>
          </div>
        )}
      </div>

      {/* ------------------------------------------------ starting price */}
      <div className="flex flex-wrap items-end gap-3 border-t border-blue-200 pt-4">
        <label className={`${label} w-36`}>
          {single ? "Price (৳)" : "Starting price (৳)"} <span className="sr-only">required</span>
          <input
            type="number"
            min={0}
            step="1"
            value={basePrice}
            onChange={(event) => setBasePrice(event.target.value)}
            className={`${input} tabular-nums`}
          />
        </label>
        <label className={`${label} w-36`}>
          Sold as
          <select value={baseMode} onChange={(event) => setBaseMode(event.target.value)} className={input}>
            <option value="preorder">Preorder</option>
            <option value="in_stock">In stock</option>
          </select>
        </label>
        {live.length === 0 ? (
          <Button type="button" size="sm" disabled={pending} onClick={() => void run(async () => {
            const created = await generate(options.map((entry) => entry.id));
            return created ? `${created} variant${created === 1 ? "" : "s"} created.` : "Nothing new to create.";
          })}>
            {single ? "Set price" : "Create variants"}
          </Button>
        ) : live.length > 1 ? (
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={samePriceForAll}>
            Same price for all
          </Button>
        ) : null}
        <p className="basis-full text-[0.75rem] text-ink/70">
          {single
            ? "Used when the product's variant is created."
            : "New variants start at this price. Different prices per variant: open a variant below."}
        </p>
      </div>

      {/* ------------------------------------------------ variants */}
      {live.length > 0 || showArchived ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-meta">
            <span className="font-semibold text-ink">
              {live.length} variant{live.length === 1 ? "" : "s"}
            </span>
            {checked.size > 0 ? (
              <>
                <span className="text-ink/70">·</span>
                <span className="text-ink">{checked.size} selected</span>
                <button type="button" className="admin-chip" disabled={pending} onClick={() => bulkEnabled(true)}>Turn on</button>
                <button type="button" className="admin-chip" disabled={pending} onClick={() => bulkEnabled(false)}>Turn off</button>
                <button type="button" className="admin-chip !text-stamp-red-text" disabled={pending} onClick={() => removeVariants([...checked])}>Delete</button>
              </>
            ) : null}
            {archivedCount > 0 ? (
              <label className="ml-auto flex items-center gap-1.5 text-[0.75rem] text-ink/70">
                <input type="checkbox" className="size-4" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
                Show {archivedCount} archived
              </label>
            ) : null}
          </div>

          {/* The SKU and the stock come off on a narrow screen — both are in
              the row that opens under a variant — so the grid fits a phone
              rather than being dragged sideways at any width.

              The box stays `relative` so the screen-reader-only labels inside
              it (which are absolutely positioned) are clipped by it too:
              without that they escaped and widened the whole page to 655px on
              a 390px screen. */}
          <div className="relative w-full max-w-full overflow-x-auto rounded-card border border-blue-200">
            <table className="admin-table md:min-w-[640px] [&_thead_th]:!static">
              <thead>
                <tr>
                  <th scope="col" className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all variants"
                      className="size-4"
                      checked={checked.size > 0 && checked.size === live.length}
                      onChange={(event) => setChecked(event.target.checked ? new Set(live.map((variant) => variant.id)) : new Set())}
                    />
                  </th>
                  <th scope="col">Variant</th>
                  <th scope="col" className="hidden md:table-cell">SKU</th>
                  <th scope="col" className="text-right">Price <span aria-hidden="true" className="text-stamp-red-text">*</span></th>
                  <th scope="col" className="hidden text-right sm:table-cell">Stock</th>
                  <th scope="col">State</th>
                  <th scope="col" className="w-10"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((variant) => {
                  const state = stateOf(variant);
                  const open = openVariant === variant.id || (single && live.length === 1 && !variant.archived && openVariant === null);
                  return (
                    <Fragment key={variant.id}>
                      <tr className={variant.archived ? "text-ink/70" : "cursor-pointer"} onClick={(event) => {
                        if ((event.target as HTMLElement).closest("input,button,a,label")) return;
                        if (!variant.archived) setOpenVariant(open ? "" : variant.id);
                      }}>
                        <td>
                          {variant.archived ? null : (
                            <input
                              type="checkbox"
                              aria-label={`Select ${variant.label}`}
                              className="size-4"
                              checked={checked.has(variant.id)}
                              onChange={() => setChecked((current) => toggle(current, variant.id))}
                            />
                          )}
                        </td>
                        <td>
                          <span className="flex items-center gap-2">
                            <span className="size-8 shrink-0 overflow-hidden rounded-[5px] border border-blue-200 bg-blue-50">
                              {variant.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={variant.imageUrl} alt="" className="size-full object-cover" />
                              ) : null}
                            </span>
                            <span className="font-medium text-ink">{variant.label}</span>
                          </span>
                        </td>
                        <td className="hidden whitespace-nowrap font-mono text-[0.75rem] text-ink/70 md:table-cell">{variant.sku}</td>
                        <td className="whitespace-nowrap text-right tabular-nums">
                          {variant.priceBdt <= 0 ? (
                            <span className="font-semibold text-stamp-red-text">Not set</span>
                          ) : variant.salePriceBdt !== null ? (
                            <>
                              <span className="text-stamp-red-text">{formatBdt(variant.salePriceBdt)}</span>{" "}
                              <s className="text-[0.75rem] text-ink/70">{formatBdt(variant.priceBdt)}</s>
                            </>
                          ) : (
                            formatBdt(variant.priceBdt)
                          )}
                        </td>
                        <td className="hidden whitespace-nowrap text-right tabular-nums text-ink/80 sm:table-cell">{stockText(variant)}</td>
                        <td className="whitespace-nowrap"><StatusBadge tone={state.tone}>{state.text}</StatusBadge></td>
                        <td className="text-right">
                          {variant.archived ? (
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => void run(async () => (await call(`/api/admin/variants/${variant.id}`, "POST", { action: "restore" })) ? `${variant.label} restored.` : null)}
                              className="text-[0.75rem] font-semibold text-blue-600 hover:underline"
                            >
                              Restore
                            </button>
                          ) : (
                            <button
                              type="button"
                              aria-expanded={open}
                              onClick={() => setOpenVariant(open ? "" : variant.id)}
                              className="inline-flex size-8 items-center justify-center rounded text-blue-600 hover:bg-blue-50"
                            >
                              <span aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
                              <span className="sr-only">{open ? "Close" : "Edit"} {variant.label}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                      {open ? (
                        <tr>
                          <td colSpan={7} className="bg-paper-raised">
                            <VariantEditor
                              variant={variant}
                              photos={photos}
                              productId={productId}
                              productTitle={productTitle}
                              pending={pending}
                              call={call}
                              run={run}
                              onDelete={() => removeVariants([variant.id])}
                              onClose={() => setOpenVariant("")}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > ROWS_SHOWN ? (
            <button type="button" onClick={() => setShowAll((current) => !current)} className="self-start text-meta font-medium text-blue-600 hover:underline">
              {showAll ? "Show fewer" : `Show all ${rows.length} variants`}
            </button>
          ) : null}
        </div>
      ) : null}

      <div aria-live="polite" className="min-h-5 text-meta">
        {error ? <p className="text-stamp-red-text">{error}</p> : message ? <p className="text-transit-green-text">{message}</p> : null}
      </div>
    </div>
  );
}

function VariantEditor({
  variant,
  photos,
  productId,
  productTitle,
  pending,
  call,
  run,
  onDelete,
  onClose,
}: {
  variant: ManagerVariant;
  photos: ManagerPhoto[];
  productId: string;
  productTitle: string;
  pending: boolean;
  call: (url: string, method: string, body?: unknown) => Promise<Record<string, unknown> | null>;
  run: (work: () => Promise<string | null | undefined>) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(variant.fulfillmentMode === "in_stock" ? "in_stock" : "preorder");
  const [payment, setPayment] = useState(variant.paymentMode === "deposit" ? "deposit" : "full");
  const [photo, setPhoto] = useState<string | null>(variant.imageId);
  const id = (name: string) => `variant-${variant.id}-${name}`;

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const number = (name: string) => (text(name) === "" ? null : Number(text(name)));
    const sale = text("sale");
    const upload = form.get("upload");
    void run(async () => {
      const saved = await call(`/api/admin/variants/${variant.id}`, "PATCH", {
        sku: text("sku"),
        priceBdt: Math.round(Number(text("price") || 0) * 100),
        salePriceBdt: sale === "" ? null : Math.round(Number(sale) * 100),
        fulfillmentMode: mode,
        stockQuantity: mode === "in_stock" ? (number("stock") ?? 0) : null,
        lowStockThreshold: mode === "in_stock" ? number("low") : null,
        preorderCapacity: mode === "preorder" ? number("capacity") : null,
        preorderClosesAt: mode === "preorder" ? isoDate(text("closes")) : null,
        estimatedArrivalFrom: isoDate(text("from")),
        estimatedArrivalTo: isoDate(text("to")),
        paymentMode: payment,
        depositPercent: payment === "deposit" ? number("deposit") : null,
        isEnabled: form.get("enabled") === "on",
      });
      if (!saved) return null;

      let imageId = photo;
      if (upload instanceof File && upload.size > 0) {
        const data = new FormData();
        data.set("file", upload);
        data.set("altText", text("uploadAlt") || `${productTitle} — ${variant.label}`);
        data.set("kind", "gallery");
        const uploaded = await call(`/api/admin/products/${productId}/images`, "POST", data);
        const image = uploaded?.image as { id: string } | undefined;
        if (!image) return null;
        imageId = image.id;
      }
      if (imageId !== variant.imageId) {
        if (!(await call(`/api/admin/variants/${variant.id}`, "POST", { action: "image", imageId }))) return null;
      }
      onClose();
      return `${variant.label} saved.`;
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4 p-2" aria-label={`Edit ${variant.label}`}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={label} htmlFor={id("price")}>
          <span>Price (৳) <span aria-hidden="true" className="text-stamp-red-text">*</span></span>
          <input id={id("price")} name="price" type="number" min={0} step="0.01" required defaultValue={(variant.priceBdt / 100).toFixed(2)} className={input} />
        </label>
        <label className={label} htmlFor={id("sale")}>
          Sale price (৳)
          <input id={id("sale")} name="sale" type="number" min={0} step="0.01" placeholder="None" defaultValue={variant.salePriceBdt === null ? "" : (variant.salePriceBdt / 100).toFixed(2)} className={input} />
        </label>
        <label className={label} htmlFor={id("sku")}>
          <span>SKU <span aria-hidden="true" className="text-stamp-red-text">*</span></span>
          <input id={id("sku")} name="sku" required defaultValue={variant.sku} className={`${input} font-mono`} />
        </label>
        <label className={label} htmlFor={id("mode")}>
          Sold as
          <select id={id("mode")} value={mode} onChange={(event) => setMode(event.target.value)} className={input}>
            <option value="preorder">Preorder</option>
            <option value="in_stock">In stock</option>
          </select>
        </label>

        {mode === "in_stock" ? (
          <>
            <label className={label} htmlFor={id("stock")}>
              <span>Stock <span aria-hidden="true" className="text-stamp-red-text">*</span></span>
              <input id={id("stock")} name="stock" type="number" min={0} defaultValue={variant.stockQuantity ?? 0} className={input} />
            </label>
            <label className={label} htmlFor={id("low")}>
              Low stock at
              <input id={id("low")} name="low" type="number" min={0} placeholder="3" defaultValue={variant.lowStockThreshold ?? ""} className={input} />
            </label>
          </>
        ) : (
          <>
            <label className={label} htmlFor={id("capacity")}>
              <span>Preorder places <span aria-hidden="true" className="text-stamp-red-text">*</span></span>
              <input id={id("capacity")} name="capacity" type="number" min={variant.preorderReserved} placeholder="How many can be ordered" defaultValue={variant.preorderCapacity ?? ""} className={input} />
              <span className="font-normal text-ink/70">{variant.preorderReserved} already reserved</span>
            </label>
            <label className={label} htmlFor={id("closes")}>
              <span>Preorder closes <span aria-hidden="true" className="text-stamp-red-text">*</span></span>
              <input id={id("closes")} name="closes" type="date" defaultValue={variant.closesAt} className={input} />
            </label>
          </>
        )}
        <label className={label} htmlFor={id("from")}>
          Arrives from
          <input id={id("from")} name="from" type="date" defaultValue={variant.arrivesFrom} className={input} />
        </label>
        <label className={label} htmlFor={id("to")}>
          Arrives by
          <input id={id("to")} name="to" type="date" defaultValue={variant.arrivesTo} className={input} />
        </label>
        <label className={label} htmlFor={id("payment")}>
          Payment
          <select id={id("payment")} value={payment} onChange={(event) => setPayment(event.target.value)} className={input}>
            <option value="full">Pay in full</option>
            <option value="deposit">Deposit</option>
          </select>
        </label>
        {payment === "deposit" ? (
          <label className={label} htmlFor={id("deposit")}>
            Deposit %
            <input id={id("deposit")} name="deposit" type="number" min={1} max={99} defaultValue={variant.depositPercent ?? 30} className={input} />
          </label>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-[0.75rem] font-medium text-ink/75">Photo for this variant</legend>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={photo === null}
            onClick={() => setPhoto(null)}
            className={`inline-flex size-12 items-center justify-center rounded-[6px] border text-[0.6875rem] ${photo === null ? "border-blue-600 ring-2 ring-blue-600/30" : "border-blue-200"} bg-paper text-ink/70`}
          >
            None
          </button>
          {photos.map((image) => (
            <button
              key={image.id}
              type="button"
              aria-pressed={photo === image.id}
              onClick={() => setPhoto(image.id)}
              className={`size-12 overflow-hidden rounded-[6px] border ${photo === image.id ? "border-blue-600 ring-2 ring-blue-600/30" : "border-blue-200"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt={image.altText} className="size-full object-cover" />
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className={`${label} min-w-48 flex-1`} htmlFor={id("upload")}>
            Or upload a new photo
            <input id={id("upload")} name="upload" type="file" accept="image/jpeg,image/png,image/webp,image/avif" className="text-[0.75rem]" />
          </label>
          <label className={`${label} min-w-48 flex-1`} htmlFor={id("uploadAlt")}>
            What it shows
            <input id={id("uploadAlt")} name="uploadAlt" placeholder={`${productTitle} — ${variant.label}`} className={input} />
          </label>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-meta text-ink">
          <input type="checkbox" name="enabled" defaultChecked={variant.isEnabled} className="size-4" />
          On sale
        </label>
        <span className="flex-1" />
        <Button type="button" size="sm" variant="quiet" onClick={onDelete} className="!text-stamp-red-text">
          Delete variant
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save variant"}
        </Button>
      </div>
    </form>
  );
}
