"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CategoryAttributeDefinition } from "@/lib/catalog/category-attributes";
import {
  inputClass,
  LabelledField,
  orNull,
  PairEditor,
  SaveRow,
  useProductSave,
} from "../editor-parts";

/**
 * Everything that ends up in the specifications table.
 *
 * Three sources, in the order a shopper reads them: the specifications this
 * product's category asks for, the optional advanced block, and any rows
 * typed by hand. Only the category's own questions are shown — a jacket is
 * never asked for a refresh rate — which is the whole point of defining them
 * per category rather than hard-coding a form.
 */

export type SpecsSectionValues = {
  id: string;
  attributeValues: Record<string, string | string[]>;
  details: Record<string, string | null>;
  specTable: { label: string; value: string }[];
};

/** The advanced block, grouped the way someone filling it in would expect. */
const DETAIL_GROUPS: { title: string; fields: { key: string; label: string }[] }[] =
  [
    {
      title: "Manufacture",
      fields: [
        { key: "manufacturer", label: "Manufacturer" },
        { key: "manufacturerPartNumber", label: "Manufacturer part number" },
        { key: "modelName", label: "Model name" },
        { key: "modelNumber", label: "Model number" },
        { key: "releaseDate", label: "Release date" },
      ],
    },
    {
      title: "The item",
      fields: [
        { key: "material", label: "Material" },
        { key: "color", label: "Colour" },
        { key: "size", label: "Size" },
        { key: "dimensions", label: "Dimensions" },
        { key: "itemWeight", label: "Item weight" },
        { key: "unitCount", label: "Unit count" },
        { key: "unitType", label: "Unit type" },
      ],
    },
    {
      title: "Packed",
      fields: [
        { key: "packageDimensions", label: "Package dimensions" },
        { key: "packageWeight", label: "Package weight" },
      ],
    },
    {
      title: "Use",
      fields: [
        { key: "compatibility", label: "Compatibility" },
        { key: "specialFeatures", label: "Special features" },
        { key: "intendedUse", label: "Intended use" },
        { key: "careInstructions", label: "Care instructions" },
      ],
    },
  ];

function AttributeInput({
  definition,
  value,
  onChange,
}: {
  definition: CategoryAttributeDefinition;
  value: string | string[] | undefined;
  onChange: (value: string | string[]) => void;
}) {
  const id = `attribute-${definition.id}`;
  const single = Array.isArray(value) ? "" : (value ?? "");

  if (definition.dataType === "multiselect") {
    const chosen = Array.isArray(value) ? value : [];

    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="text-meta font-medium text-ink">
          {definition.name}
          {definition.isRequired ? (
            <span aria-hidden="true" className="ml-1 text-stamp-red-text">
              *
            </span>
          ) : null}
        </legend>
        <div className="flex flex-wrap gap-2">
          {definition.options.map((option) => {
            const picked = chosen.includes(option);
            return (
              <label
                key={option}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 text-body ${
                  picked
                    ? "border-blue-600 bg-blue-50 font-medium text-blue-600"
                    : "border-blue-300 text-ink"
                }`}
              >
                <input
                  type="checkbox"
                  checked={picked}
                  onChange={() =>
                    onChange(
                      picked
                        ? chosen.filter((entry) => entry !== option)
                        : [...chosen, option],
                    )
                  }
                  className="size-4"
                />
                {option}
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  const common = {
    id,
    value: single,
    className: inputClass,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
    ) => onChange(event.target.value),
  };

  return (
    <LabelledField
      label={definition.name}
      htmlFor={id}
      required={definition.isRequired}
      hint={
        definition.unit
          ? `In ${definition.unit}. Defined on ${definition.categoryName}.`
          : `Defined on ${definition.categoryName}.`
      }
    >
      {definition.dataType === "select" ? (
        <select {...common}>
          <option value="">—</option>
          {definition.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : definition.dataType === "boolean" ? (
        <select {...common}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : (
        <input
          {...common}
          type={
            definition.dataType === "number" ||
            definition.dataType === "measurement"
              ? "number"
              : definition.dataType === "date"
                ? "date"
                : definition.dataType === "color"
                  ? "text"
                  : definition.dataType === "url"
                    ? "url"
                    : "text"
          }
          step={definition.dataType === "measurement" ? "any" : undefined}
        />
      )}
    </LabelledField>
  );
}

export function SpecsSection({
  product,
  definitions,
  categoryName,
}: {
  product: SpecsSectionValues;
  definitions: CategoryAttributeDefinition[];
  categoryName: string;
}) {
  const router = useRouter();
  const { save, pending, error, message, dirty, markDirty } = useProductSave(
    product.id,
    () => router.refresh(),
  );

  const [values, setValues] = useState(product.attributeValues);
  const [details, setDetails] = useState(product.details);
  const [rows, setRows] = useState(product.specTable);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Blanks are dropped rather than stored, so an emptied field disappears
    // from the product page instead of becoming a row reading "—".
    const attributeValues = Object.fromEntries(
      Object.entries(values).filter(([, value]) =>
        Array.isArray(value) ? value.length > 0 : value.trim().length > 0,
      ),
    );

    const cleanDetails = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [
        key,
        orNull(String(value ?? "")),
      ]),
    );

    await save({
      attributeValues,
      details: Object.values(cleanDetails).some(Boolean) ? cleanDetails : null,
      specTable: rows.filter((row) => row.label.trim() && row.value.trim()),
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-8" noValidate>
      <section className="flex flex-col gap-4">
        <div>
          <h3 className="font-display text-h3 text-ink">
            {categoryName} specifications
          </h3>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            Defined on the category, so every product on the same shelf is
            described the same way. Add or change them under{" "}
            <a
              href="/admin/categories"
              className="text-blue-600 underline underline-offset-4"
            >
              Categories
            </a>
            .
          </p>
        </div>

        {definitions.length === 0 ? (
          <p className="text-meta text-ink/70">
            This category asks for no specifications yet.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {definitions.map((definition) => (
              <AttributeInput
                key={definition.id}
                definition={definition}
                value={values[definition.id]}
                onChange={(value) => {
                  setValues({ ...values, [definition.id]: value });
                  markDirty();
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-6 border-t border-blue-300 pt-6">
        <div>
          <h3 className="font-display text-h3 text-ink">Advanced attributes</h3>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            All optional. Anything left blank is simply absent from the
            product page — none of these produces an empty row.
          </p>
        </div>

        {DETAIL_GROUPS.map((group) => (
          <fieldset key={group.title} className="flex flex-col gap-4">
            <legend className="text-meta font-medium uppercase tracking-[0.14em] text-ink/70">
              {group.title}
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.fields.map((field) => (
                <LabelledField
                  key={field.key}
                  label={field.label}
                  htmlFor={`detail-${field.key}`}
                >
                  <input
                    id={`detail-${field.key}`}
                    value={details[field.key] ?? ""}
                    onChange={(event) => {
                      setDetails({ ...details, [field.key]: event.target.value });
                      markDirty();
                    }}
                    className={inputClass}
                  />
                </LabelledField>
              ))}
            </div>
          </fieldset>
        ))}
      </section>

      <section className="border-t border-blue-300 pt-6">
        <PairEditor
          label="Other specifications"
          hint="Anything the category does not ask for. Both halves are needed for a row to be kept."
          items={rows}
          onChange={(items) => {
            setRows(items);
            markDirty();
          }}
        />
      </section>

      <SaveRow pending={pending} dirty={dirty} error={error} message={message} />
    </form>
  );
}
