"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { inputClass, LabelledField, orNull, SaveRow, useProductSave } from "../editor-parts";

/**
 * The shop's own label for what it sells (D-116).
 *
 * This is one field, and it is here rather than in Product identity for a
 * reason a new employee has to be able to feel: a SKU is Manifest's code for a
 * thing on a shelf, and the model number and barcode above it are the
 * manufacturer's name for what that thing *is*. Researching a product uses the
 * second kind and never the first, so mixing them in one panel taught staff to
 * type a Manifest SKU where a manufacturer's part number belonged.
 *
 * Prices, stock, preorder capacity and closing dates are not repeated here:
 * they belong to a variant, and the variants table below this panel is where
 * they already live. A second form for the same numbers would be a second
 * place for them to disagree.
 */
export function SellingSection({ product }: { product: { id: string; sku: string | null } }) {
  const router = useRouter();
  const { save, pending, error, message, dirty, markDirty } = useProductSave(product.id, () =>
    router.refresh(),
  );
  const [sku, setSku] = useState(product.sku ?? "");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save({ sku: orNull(sku) });
      }}
      className="flex max-w-2xl flex-col gap-6"
      noValidate
    >
      <LabelledField
        label="Manifest SKU"
        htmlFor="sku"
        hint="This shop's own code for the listing. No two products may share one. It is not a manufacturer's number."
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

      <SaveRow pending={pending} dirty={dirty} error={error} message={message} label="Save SKU" />
    </form>
  );
}
