"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import { describeDiscovery } from "@/lib/preparation/presentation";

type CategoryOption = { id: string; label: string };

/**
 * Add product: tell Manifest which product this is (D-116).
 *
 * The old form asked for a whole catalogue record — description, key points,
 * SKU — before anything was known about the product, which is exactly the work
 * SeoPulse now does. What is left is the small part only a person can supply:
 * the name, the brand, the category, and optionally the few identifiers a
 * manufacturer would recognise.
 *
 * There are two ways out of this screen and both are real. *Research & Prepare
 * with SeoPulse* creates the product and starts a preparation run in one
 * movement, then opens the editor where that run reports itself. *Save without
 * SeoPulse* creates the same product and stops, which is the right path for a
 * private-label or locally sourced product that no manufacturer's page
 * describes.
 *
 * Nothing here is a second store for anything. The identity fields are the
 * ones `productIdentitySchema` already accepts and `identityColumns` already
 * folds into the columns the knowledge base reads; the official URL is
 * attached as a source by the product save itself. The Manifest SKU is kept
 * deliberately apart from them, because a SKU is this shop's own label for
 * something it sells, not the manufacturer's name for what it is.
 */

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

/** The trade identifiers a listing may carry. It carries one; see D-065. */
const IDENTIFIER_KINDS = [
  { value: "", label: "Not known" },
  { value: "gtin", label: "GTIN" },
  { value: "upc", label: "UPC" },
  { value: "ean", label: "EAN" },
  { value: "isbn", label: "ISBN" },
  { value: "asin", label: "ASIN" },
] as const;

const selectClass =
  "min-h-11 w-full rounded-control border border-blue-300 bg-paper px-3 text-body text-ink";

export function ProductForm({
  categories,
  discoveryConfigured = false,
}: {
  categories: CategoryOption[];
  /** Whether automatic source discovery is set up, in staff terms only. */
  discoveryConfigured?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<null | "prepare" | "manual">(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [sku, setSku] = useState("");
  const [holdError, setHoldError] = useState(false);
  const [identifierKind, setIdentifierKind] = useState("");
  const [showIdentity, setShowIdentity] = useState(false);

  /*
   * A product created by a submission that then failed to start preparation is
   * remembered, so pressing the button again continues with that product
   * instead of creating a second one. The request key is remembered for the
   * same reason: the preparation API is idempotent on it, so a retried start
   * returns the run it already made rather than a duplicate.
   */
  const created = useRef<string | null>(null);
  const requestKey = useRef<string | null>(null);

  const discovery = describeDiscovery(discoveryConfigured);

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

  function identityFrom(form: FormData): Record<string, string> {
    const identity: Record<string, string> = {};
    const put = (key: string, value: FormDataEntryValue | null) => {
      const text = String(value ?? "").trim();
      if (text) identity[key] = text;
    };
    put("modelName", form.get("modelName"));
    put("modelNumber", form.get("modelNumber"));
    put("mpn", form.get("mpn"));
    put("officialUrl", form.get("officialUrl"));
    if (identifierKind) put(identifierKind, form.get("identifierValue"));
    return identity;
  }

  /** Creates the product, or returns the one an earlier attempt created. */
  async function createProduct(form: FormData): Promise<string | null> {
    if (created.current) return created.current;

    const identity = identityFrom(form);
    const response = await fetch("/api/admin/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        categoryId: form.get("categoryId"),
        brand: form.get("brand") || undefined,
        sku: form.get("sku") || undefined,
        skuReservationId: hold?.id ?? undefined,
        ...(Object.keys(identity).length > 0 ? { identity } : {}),
      }),
    }).catch(() => null);

    const body = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) {
      // The hold is untouched by a failed save, so a retry keeps the SKU.
      setError(body.error ?? "Something went wrong. Try again.");
      return null;
    }

    // The SKU now belongs to the product; the next new product gets its own.
    window.localStorage.removeItem(HOLD_KEY);
    created.current = body.product.id as string;
    return created.current;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mode = (event.nativeEvent as SubmitEvent).submitter?.dataset.mode === "manual" ? "manual" : "prepare";
    setPending(mode);
    setError(null);

    const form = new FormData(event.currentTarget);
    const productId = await createProduct(form);
    if (!productId) {
      setPending(null);
      return;
    }

    if (mode === "manual") {
      router.push(`/admin/products/${productId}?created=1`);
      router.refresh();
      return;
    }

    requestKey.current ??= crypto.randomUUID();
    const started = await fetch(`/api/admin/products/${productId}/preparation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestKey: requestKey.current }),
    }).catch(() => null);

    if (!started?.ok) {
      // The product exists either way, so the editor is still where this goes;
      // the preparation panel there offers the same action again.
      const body = started ? await started.json().catch(() => ({})) : {};
      setError(
        (body as { error?: string }).error ??
          "The product was saved, but preparation could not be started. Try it again from the product.",
      );
      setPending(null);
      return;
    }

    router.push(`/admin/products/${productId}?created=1&preparing=1`);
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
        ? "Generated and held for this product. You can replace it."
        : "Your own SKU. It is checked when you save; no two products may share one.";

  const busy = pending !== null;

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-5" noValidate>
      <section className="admin-card flex flex-col gap-5">
        <div>
          <h2 className="admin-h2 text-body">Which product is this?</h2>
          <p className="mt-0.5 text-meta text-ink/65">
            Three things to start with. Everything else is added after SeoPulse has researched it.
          </p>
        </div>

        <Field
          label="Product name"
          name="title"
          required
          autoComplete="off"
          hint="What a shopper sees first. Used to build the address of the page."
        />

        <Field
          label="Brand"
          name="brand"
          required
          autoComplete="off"
          hint="Use Generic where a product has no brand of its own."
        />

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-1">
            <label htmlFor="categoryId" className="text-meta font-medium text-ink">
              Category
            </label>
            <span aria-hidden="true" className="text-stamp-red-text">
              *
            </span>
          </div>
          <select id="categoryId" name="categoryId" required className={selectClass}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
          <p className="text-meta text-ink/70">The category decides which specifications this product is asked for.</p>
        </div>
      </section>

      <section className="admin-card flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="admin-h2 text-body">Help SeoPulse identify the exact product</h2>
            <p className="mt-0.5 max-w-[60ch] text-meta text-ink/65">
              All optional, and all worth having. One model number or barcode is usually enough to tell two similar
              versions apart.
            </p>
          </div>
          <button
            type="button"
            aria-expanded={showIdentity}
            aria-controls="identity-fields"
            onClick={() => setShowIdentity((current) => !current)}
            className="shrink-0 rounded-control px-2 py-1 text-meta font-medium text-blue-600 hover:bg-blue-50"
          >
            {showIdentity ? "Hide" : "Add details"}
          </button>
        </div>

        <p
          className={`flex items-center gap-2 text-meta ${
            discovery.available ? "text-transit-green-text" : "text-brass-text"
          }`}
        >
          <span aria-hidden="true">{discovery.available ? "✓" : "!"}</span>
          {discovery.label}
        </p>
        <p className="max-w-[60ch] text-meta text-ink/65">{discovery.hint}</p>

        <div id="identity-fields" hidden={!showIdentity} className="flex flex-col gap-5 border-t border-blue-200 pt-4">
          <Field label="Model" name="modelName" autoComplete="off" hint="The manufacturer's name for it, such as WH-1000XM6." />
          <Field label="Model number" name="modelNumber" autoComplete="off" hint="Where it differs from the model name." />
          <Field label="Manufacturer part number (MPN)" name="mpn" autoComplete="off" />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-3">
            <div className="flex w-full flex-col gap-2 sm:w-44">
              <label htmlFor="identifierKind" className="text-meta font-medium text-ink">
                Barcode type
              </label>
              <select
                id="identifierKind"
                name="identifierKind"
                value={identifierKind}
                onChange={(event) => setIdentifierKind(event.target.value)}
                className={selectClass}
              >
                {IDENTIFIER_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0 flex-1">
              <Field
                label="Barcode number"
                name="identifierValue"
                autoComplete="off"
                disabled={!identifierKind}
                hint="A product carries one number. Choose which kind it is, then type it exactly as printed."
              />
            </div>
          </div>

          <Field
            label="Official product URL"
            name="officialUrl"
            type="url"
            inputMode="url"
            placeholder="https://"
            autoComplete="off"
            hint="The manufacturer's own page for this product. Recorded as a source for the research."
          />
        </div>
      </section>

      <section className="admin-card flex flex-col gap-4">
        <div>
          <h2 className="admin-h2 text-body">Your own reference</h2>
          <p className="mt-0.5 max-w-[60ch] text-meta text-ink/65">
            The SKU is Manifest&rsquo;s label for what you sell. It is not one of the manufacturer&rsquo;s numbers above.
          </p>
        </div>
        <Field
          label="Manifest SKU"
          name="sku"
          value={sku}
          onChange={(event) => setSku(event.target.value)}
          hint={skuHint}
        />
        <p className="text-meta text-ink/70">
          Saved as a draft, not visible to shoppers. You publish it from the next screen once it has a photograph and
          something priced to buy.
        </p>
      </section>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="submit" data-mode="prepare" disabled={busy}>
          {pending === "prepare" ? "Starting…" : "Research & Prepare with SeoPulse"}
        </Button>
        <Button type="submit" data-mode="manual" variant="secondary" disabled={busy}>
          {pending === "manual" ? "Saving…" : "Save without SeoPulse"}
        </Button>
        <Button type="button" variant="quiet" onClick={() => void onCancel()} disabled={busy}>
          Cancel
        </Button>
      </div>
      <p className="max-w-[60ch] text-meta text-ink/65">
        SeoPulse researches the product, checks what it finds, and prepares the description and search wording. You
        review only what it asks about, then add the price, stock and photographs.
      </p>
    </form>
  );
}
