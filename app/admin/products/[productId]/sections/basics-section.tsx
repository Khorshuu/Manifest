"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  inputClass,
  LabelledField,
  orNull,
  SaveRow,
  useProductSave,
} from "../editor-parts";
import { isStrongModelKey, variantDescriptor } from "@/lib/pkb/identity-labels";

export type CategoryOption = { id: string; label: string };

export type BasicsSectionValues = {
  id: string;
  title: string;
  slug: string;
  categoryId: string;
  brand: string | null;
  sku: string | null;
  identifierType: string | null;
  identifierValue: string | null;
  /** Manufacturer identity, stored in `products.details` (D-112). */
  modelName: string | null;
  modelNumber: string | null;
  mpn: string | null;
  status: string;
  archived: boolean;
};

/**
 * The identifier types a listing may carry.
 *
 * "None" is the default and stays a real answer: a locally sourced accessory
 * has no GTIN, and a form that insists on one only teaches staff to invent
 * numbers.
 */
const IDENTIFIER_TYPES = [
  { value: "", label: "None" },
  { value: "gtin", label: "GTIN" },
  { value: "upc", label: "UPC" },
  { value: "ean", label: "EAN" },
  { value: "isbn", label: "ISBN" },
  { value: "asin", label: "ASIN" },
  { value: "mpn", label: "Manufacturer part number" },
  { value: "other", label: "Other" },
] as const;

export function BasicsSection({
  product,
  categories,
  identityStatus,
  intelligenceHref,
  onCategoryChange,
}: {
  product: BasicsSectionValues;
  categories: CategoryOption[];
  /** Identified / Needs review / Needs information, from the knowledge base. */
  identityStatus?: { label: string; tone: "good" | "warn" | "plain"; detail: string };
  /** Where the underlying resolution evidence lives, for whoever wants it. */
  intelligenceHref?: string;
  /** The specifications panel follows the category, so it is told about it. */
  onCategoryChange?: (categoryId: string) => void;
}) {
  const router = useRouter();
  const { save, pending, error, message, dirty, markDirty } = useProductSave(
    product.id,
    () => router.refresh(),
  );

  const [title, setTitle] = useState(product.title);
  const [categoryId, setCategoryId] = useState(product.categoryId);
  const [brand, setBrand] = useState(product.brand ?? "");
  const [identifierType, setIdentifierType] = useState(
    product.identifierType ?? "",
  );
  const [identifierValue, setIdentifierValue] = useState(
    product.identifierValue ?? "",
  );
  const [modelName, setModelName] = useState(product.modelName ?? "");
  const [modelNumber, setModelNumber] = useState(product.modelNumber ?? "");
  const [mpn, setMpn] = useState(product.mpn ?? "");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await save({
      // Always sent, even when blank: an empty title has to reach the schema
      // so it comes back with the sentence that says what to do about it.
      title,
      categoryId,
      brand: orNull(brand),
      // The SKU is the Selling information panel's field, not this one's: a
      // panel never sends a field it does not show, or it would save a stale
      // copy over whatever the other panel just wrote.
      identifierType: identifierType === "" ? null : identifierType,
      identifierValue: orNull(identifierValue),
      /*
       * The manufacturer's own names for the product (D-112). Sent as an
       * identity block rather than as `details`, so the save folds them into
       * the stored details instead of replacing that object — the
       * specifications panel owns the rest of it.
       */
      identity: {
        modelName: modelName.trim(),
        modelNumber: modelNumber.trim(),
        mpn: mpn.trim(),
      },
      // Status is not sent from here: publishing, unpublishing and archiving
      // go through the action bar and the Visibility tab, which check the
      // listing is ready before it goes in front of shoppers.
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-6" noValidate>
      {identityStatus ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-blue-200 bg-blue-50/40 px-3 py-2">
          <p className="flex items-center gap-2 text-meta">
            <span
              aria-hidden="true"
              className={
                identityStatus.tone === "good"
                  ? "text-transit-green-text"
                  : identityStatus.tone === "warn"
                    ? "text-brass-text"
                    : "text-ink/50"
              }
            >
              {identityStatus.tone === "good" ? "✓" : identityStatus.tone === "warn" ? "!" : "○"}
            </span>
            <span className="font-medium text-ink">{identityStatus.label}</span>
            <span className="text-ink/65">{identityStatus.detail}</span>
          </p>
          {intelligenceHref ? (
            <a href={intelligenceHref} className="shrink-0 text-meta text-blue-600 underline-offset-4 hover:underline">
              View product intelligence
            </a>
          ) : null}
        </div>
      ) : null}

      <LabelledField
        label="Product name"
        htmlFor="title"
        required
        hint="What a shopper sees first, and what the address is built from."
      >
        <input
          id="title"
          name="title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            markDirty();
          }}
          className={inputClass}
        />
      </LabelledField>

      <LabelledField label="Category" htmlFor="categoryId" required>
        <select
          id="categoryId"
          name="categoryId"
          value={categoryId}
          onChange={(event) => {
            setCategoryId(event.target.value);
            onCategoryChange?.(event.target.value);
            markDirty();
          }}
          className={inputClass}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      </LabelledField>

      <LabelledField
        label="Brand"
        htmlFor="brand"
        hint="Use Generic where a product has no brand of its own."
      >
        <input
          id="brand"
          name="brand"
          value={brand}
          onChange={(event) => {
            setBrand(event.target.value);
            markDirty();
          }}
          className={inputClass}
        />
      </LabelledField>

      <div className="flex flex-col gap-4 border-t border-blue-200 pt-5">
        <div>
          <h3 className="text-meta font-semibold uppercase tracking-[0.08em] text-ink/70">
            How the manufacturer names it
          </h3>
          <p className="mt-0.5 max-w-[60ch] text-meta text-ink/65">
            Optional, and what lets Manifest tell two similar versions apart. These are the
            manufacturer&rsquo;s numbers, not your own — the Manifest SKU is under Selling information.
          </p>
        </div>

        <LabelledField label="Model" htmlFor="modelName" hint="The manufacturer's name for it, such as WH-1000XM6.">
          <input
            id="modelName"
            name="modelName"
            value={modelName}
            onChange={(event) => {
              setModelName(event.target.value);
              markDirty();
            }}
            className={inputClass}
          />
          <WeakCodeNote value={modelName} kind="name" />
        </LabelledField>

        <div className="grid gap-4 sm:grid-cols-2">
          <LabelledField label="Model number" htmlFor="modelNumber" hint="Where it differs from the model name.">
            <input
              id="modelNumber"
              name="modelNumber"
              value={modelNumber}
              onChange={(event) => {
                setModelNumber(event.target.value);
                markDirty();
              }}
              className={inputClass}
            />
            <WeakCodeNote value={modelNumber} kind="code" />
          </LabelledField>

          <LabelledField label="Manufacturer part number (MPN)" htmlFor="mpn">
            <input
              id="mpn"
              name="mpn"
              value={mpn}
              onChange={(event) => {
                setMpn(event.target.value);
                markDirty();
              }}
              className={inputClass}
            />
            <WeakCodeNote value={mpn} kind="code" />
          </LabelledField>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <LabelledField label="Identifier type" htmlFor="identifierType">
          <select
            id="identifierType"
            name="identifierType"
            value={identifierType}
            onChange={(event) => {
              setIdentifierType(event.target.value);
              markDirty();
            }}
            className={inputClass}
          >
            {IDENTIFIER_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </LabelledField>

        <LabelledField
          label="Identifier"
          htmlFor="identifierValue"
          hint="Leave both empty where the product has no barcode."
        >
          <input
            id="identifierValue"
            name="identifierValue"
            value={identifierValue}
            onChange={(event) => {
              setIdentifierValue(event.target.value);
              markDirty();
            }}
            className={inputClass}
          />
        </LabelledField>
      </div>

      <p className="text-meta text-ink/70">
        Address: <span className="font-mono">/products/{product.slug}</span>. Whether customers
        can see this product is set with <strong>Publish now</strong> at the top, or on the{" "}
        <strong>Visibility</strong> tab.
      </p>

      <SaveRow
        pending={pending}
        dirty={dirty}
        error={error}
        message={message}
        label="Save changes"
      />
    </form>
  );
}

/**
 * Says when a value typed into a model field cannot identify a product
 * (D-123): "Shade 10" is a shade, "10" and "(1N)" are too short. The value is
 * kept as typed; it is only not used to decide which product this is.
 */
function WeakCodeNote({ value, kind }: { value: string; kind: "name" | "code" }) {
  const text = value.trim();
  if (!text) return null;
  const variant = variantDescriptor(text);
  if (kind === "name" && !variant) return null;
  if (kind === "code" && isStrongModelKey(text)) return null;
  return (
    <p className="text-meta text-ink/70" data-weak-code>
      {variant
        ? `“${text}” reads as a ${variant.dimension}, not the manufacturer's model. It is kept, but not used to identify the product.`
        : `“${text}” is too short to identify a product — it reads like a shade, size or tone code — so it is not used to match sources. Add the GTIN/UPC from the package if there is no manufacturer model number.`}
    </p>
  );
}
