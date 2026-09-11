"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";

type CategoryOption = { id: string; label: string };

/**
 * The browser remembers which SKU hold this form was given, so a refresh, a
 * closed tab or a lost connection comes back to the same SKU instead of
 * generating another. The server decides whether the hold is still this
 * admin's; the browser can only hand back an id it was given.
 */
const HOLD_KEY = "manifest.admin.sku-hold";

type Hold = { id: string; sku: string };

/*
 * One request per form opening, however many times React mounts the form.
 * Development mode mounts every component twice; without this each opening
 * asked the server for two SKUs and abandoned one, which then sat held until
 * it expired. The id is remembered even if the form unmounted before the
 * answer came, so the hold is renewed next time rather than orphaned.
 */
let inflight: Promise<Hold> | null = null;

function requestHold(): Promise<Hold> {
  if (!inflight) {
    const remembered = window.localStorage.getItem(HOLD_KEY);
    inflight = fetch("/api/admin/products/sku-reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reservationId: remembered || null }),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { reservation: Hold }) => {
        window.localStorage.setItem(HOLD_KEY, body.reservation.id);
        return { id: body.reservation.id, sku: body.reservation.sku };
      })
      .finally(() => {
        // Cleared after this tick, so a second mount in the same moment still
        // shares the request but a later opening asks afresh.
        window.setTimeout(() => {
          inflight = null;
        }, 0);
      });
  }
  return inflight;
}

export function ProductForm({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [hold, setHold] = useState<Hold | null>(null);
  const [sku, setSku] = useState("");
  const [holdError, setHoldError] = useState(false);

  // Reserve (or renew) a SKU the moment the form opens.
  useEffect(() => {
    let live = true;

    requestHold()
      .then((reserved) => {
        if (!live) return;
        setHold(reserved);
        setSku((current) => current || reserved.sku);
      })
      .catch(() => {
        if (live) setHoldError(true);
      });

    return () => {
      live = false;
    };
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const bullets = String(form.get("bulletFeatures") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const response = await fetch("/api/admin/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        categoryId: form.get("categoryId"),
        brand: form.get("brand") || undefined,
        sku: form.get("sku") || undefined,
        skuReservationId: hold?.id ?? undefined,
        descriptionHtml: form.get("descriptionHtml") || undefined,
        bulletFeatures: bullets.length > 0 ? bullets : undefined,
        status: form.get("status"),
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      // The hold is untouched by a failed save, so a retry keeps the SKU.
      setError(body.error ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    // The SKU now belongs to the product; the next new product gets its own.
    window.localStorage.removeItem(HOLD_KEY);

    // Straight into the wizard at the next step: a product created and then
    // left in a list is a product with no photograph and no price
    // (MASTER_PRODUCT_SPEC.md section 4).
    // Into the editor, where the action bar says it is a draft and offers
    // Publish now once the listing is ready.
    router.push(`/admin/products/${body.product.id}?created=1`);
    router.refresh();
  }

  async function onCancel() {
    // Abandoning the form gives the SKU back. If this request never arrives,
    // the hold simply expires and the maintenance sweep frees it.
    if (hold) {
      window.localStorage.removeItem(HOLD_KEY);
      await fetch(`/api/admin/products/sku-reservations/${hold.id}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
    router.push("/admin/products");
  }

  const skuHint = holdError
    ? "A SKU could not be generated. Enter one, or reload to try again."
    : !hold
      ? "Generating a SKU…"
      : sku === hold.sku
        ? "Automatically generated and held for this product. You can replace it."
        : "Your own SKU. It is checked when you save; no two products may share one.";

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-6" noValidate>
      <Field
        label="Title"
        name="title"
        required
        hint="What a shopper sees first. Used to build the URL."
      />

      <div className="flex flex-col gap-2">
        <label htmlFor="categoryId" className="text-meta font-medium text-ink">
          Category
        </label>
        <select
          id="categoryId"
          name="categoryId"
          required
          className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      </div>

      <Field
        label="Brand"
        name="brand"
        hint="Use Generic where a product has no brand of its own."
      />

      <Field
        label="SKU"
        name="sku"
        value={sku}
        onChange={(event) => setSku(event.target.value)}
        hint={skuHint}
      />

      <div className="flex flex-col gap-2">
        <label htmlFor="status" className="text-meta font-medium text-ink">
          Status
        </label>
        <select
          id="status"
          name="status"
          defaultValue="draft"
          className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
        >
          <option value="draft">Draft — not visible to shoppers</option>
          <option value="coming_soon">Coming soon</option>
          <option value="preorder_open">Preorder open</option>
          <option value="in_stock">In stock</option>
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="bulletFeatures"
          className="text-meta font-medium text-ink"
        >
          Key points
        </label>
        <textarea
          id="bulletFeatures"
          name="bulletFeatures"
          rows={4}
          placeholder={"Sourced direct from the US\nArrives sealed"}
          className="rounded-control border border-blue-300 bg-paper p-3 text-body text-ink"
        />
        <p className="text-meta text-ink/70">One per line.</p>
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="descriptionHtml"
          className="text-meta font-medium text-ink"
        >
          Description
        </label>
        <textarea
          id="descriptionHtml"
          name="descriptionHtml"
          rows={6}
          className="rounded-control border border-blue-300 bg-paper p-3 text-body text-ink"
        />
      </div>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save product"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => void onCancel()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
