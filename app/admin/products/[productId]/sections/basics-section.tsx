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
  onCategoryChange,
}: {
  product: BasicsSectionValues;
  categories: CategoryOption[];
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
  const [sku, setSku] = useState(product.sku ?? "");
  const [identifierType, setIdentifierType] = useState(
    product.identifierType ?? "",
  );
  const [identifierValue, setIdentifierValue] = useState(
    product.identifierValue ?? "",
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await save({
      // Always sent, even when blank: an empty title has to reach the schema
      // so it comes back with the sentence that says what to do about it.
      title,
      categoryId,
      brand: orNull(brand),
      sku: orNull(sku),
      identifierType: identifierType === "" ? null : identifierType,
      identifierValue: orNull(identifierValue),
      // Status is not sent from here: publishing, unpublishing and archiving
      // go through the action bar and the Visibility tab, which check the
      // listing is ready before it goes in front of shoppers.
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-6" noValidate>
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

      <LabelledField
        label="SKU"
        htmlFor="sku"
        hint="The shop's own code for this listing. No two products may share one."
      >
        <input
          id="sku"
          name="sku"
          value={sku}
          onChange={(event) => {
            setSku(event.target.value);
            markDirty();
          }}
          className={inputClass}
        />
      </LabelledField>

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
