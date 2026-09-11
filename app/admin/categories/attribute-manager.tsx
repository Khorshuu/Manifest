"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/button";
import { IconAlert, IconCheck } from "@/components/icons";
import type { CategoryAttributeDefinition } from "@/lib/catalog/category-attributes";

/**
 * The specifications a category asks its products for.
 *
 * This is what keeps the product form from having to hard-code a field for
 * every kind of thing the shop might ever sell: a category is given its own
 * questions here, and every product filed under it — or under anything
 * beneath it — is asked them.
 */

const TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes or no" },
  { value: "select", label: "One of a list" },
  { value: "multiselect", label: "Several of a list" },
  { value: "date", label: "Date" },
  { value: "measurement", label: "Measurement" },
  { value: "color", label: "Colour" },
  { value: "url", label: "Link" },
] as const;

const inputClass =
  "min-h-11 w-full rounded-control border border-blue-300 bg-paper px-3 text-body text-ink";

export function AttributeManager({
  categories,
  initial,
}: {
  categories: { id: string; label: string }[];
  /**
   * The first category is rendered on the server, so this list is complete on
   * the first paint and nothing is fetched until a different category is
   * chosen — there is no effect here, and so no flash of an empty list.
   */
  initial: {
    categoryId: string;
    own: CategoryAttributeDefinition[];
    inherited: CategoryAttributeDefinition[];
  };
}) {
  const [categoryId, setCategoryId] = useState(initial.categoryId);
  const [own, setOwn] = useState<CategoryAttributeDefinition[]>(initial.own);
  const [inherited, setInherited] = useState<CategoryAttributeDefinition[]>(
    initial.inherited,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [dataType, setDataType] = useState<string>("text");
  const [unit, setUnit] = useState("");
  const [options, setOptions] = useState("");
  const [required, setRequired] = useState(false);
  /** Null follows the kind of value; a tick makes it the staff member's call. */
  const [filterable, setFilterable] = useState<boolean | null>(null);
  const [searchable, setSearchable] = useState(true);

  // Free text, links and dates give every product its own value, which makes
  // a filter nobody can use; the rest group products into a few values.
  const filterableByDefault = !["text", "url", "date"].includes(dataType);
  const filterableShown = filterable ?? filterableByDefault;

  /*
   * Nothing is set synchronously here: the first state change happens after
   * the requests have been awaited, so switching category does not cascade a
   * render before the answer arrives.
   */
  const load = useCallback(async (id: string) => {
    if (!id) return;

    const [ownResponse, allResponse] = await Promise.all([
      fetch(`/api/admin/categories/${id}/attributes`),
      fetch(`/api/admin/categories/${id}/attributes?inherited=1`),
    ]);

    if (!ownResponse.ok || !allResponse.ok) {
      setError("Could not load the specifications for that category.");
      return;
    }

    const ownBody = await ownResponse.json();
    const allBody = await allResponse.json();
    const ownIds = new Set(
      (ownBody.attributes as CategoryAttributeDefinition[]).map(
        (attribute) => attribute.id,
      ),
    );

    setOwn(ownBody.attributes);
    // Everything asked of a product here that is not defined here — the
    // inherited part, shown but not editable from this category.
    setInherited(
      (allBody.attributes as CategoryAttributeDefinition[]).filter(
        (attribute) => !ownIds.has(attribute.id),
      ),
    );
  }, []);

  const needsOptions = dataType === "select" || dataType === "multiselect";

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch(
      `/api/admin/categories/${categoryId}/attributes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          dataType,
          unit: unit.trim() || null,
          options: needsOptions
            ? options
                .split(",")
                .map((option) => option.trim())
                .filter(Boolean)
            : undefined,
          isRequired: required,
          isFilterable: filterableShown,
          isSearchable: searchable,
        }),
      },
    );

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setName("");
    setUnit("");
    setOptions("");
    setRequired(false);
    setFilterable(null);
    setSearchable(true);
    setMessage("Specification added.");
    void load(categoryId);
  }

  /**
   * Switches whether a specification is a filter, or searched. The whole
   * definition is sent back because the update replaces it; only the one
   * switch differs.
   */
  async function toggle(
    attribute: CategoryAttributeDefinition,
    change: { isFilterable?: boolean; isSearchable?: boolean },
  ) {
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch(
      `/api/admin/category-attributes/${attribute.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: attribute.name,
          dataType: attribute.dataType,
          unit: attribute.unit,
          options: attribute.options.length > 0 ? attribute.options : undefined,
          isRequired: attribute.isRequired,
          isFilterable: change.isFilterable ?? attribute.isFilterable,
          isSearchable: change.isSearchable ?? attribute.isSearchable,
        }),
      },
    );

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage(
      change.isFilterable !== undefined
        ? change.isFilterable
          ? `${attribute.name} is now offered as a filter.`
          : `${attribute.name} is no longer a filter.`
        : change.isSearchable
          ? `${attribute.name} is searched again.`
          : `${attribute.name} is no longer searched.`,
    );
    void load(categoryId);
  }

  async function remove(attributeId: string, attributeName: string) {
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch(
      `/api/admin/category-attributes/${attributeId}`,
      { method: "DELETE" },
    );

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage(`${attributeName} removed.`);
    void load(categoryId);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="attributeCategory" className="text-meta font-medium text-ink">
          Category
        </label>
        <select
          id="attributeCategory"
          value={categoryId}
          onChange={(event) => {
            setCategoryId(event.target.value);
            void load(event.target.value);
          }}
          className={inputClass}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <h3 className="font-display text-h3 text-ink">Asked here</h3>
        {own.length === 0 ? (
          <p className="mt-2 text-meta text-ink/70">
            Nothing yet. Products in this category are asked only for the
            general fields.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {own.map((attribute) => (
              <li
                key={attribute.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-blue-300 bg-paper px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-body text-ink">
                    {attribute.name}
                    {attribute.isRequired ? (
                      <span className="ml-2 text-meta text-stamp-red-text">
                        Required
                      </span>
                    ) : null}
                  </p>
                  <p className="text-meta text-ink/70">
                    {TYPES.find((type) => type.value === attribute.dataType)?.label ??
                      attribute.dataType}
                    {attribute.unit ? ` · ${attribute.unit}` : ""}
                    {attribute.options.length > 0
                      ? ` · ${attribute.options.join(", ")}`
                      : ""}
                  </p>
                  <p className="text-meta text-ink/70">
                    {attribute.isFilterable ? "A filter" : "Not a filter"}
                    {" · "}
                    {attribute.isSearchable ? "Searched" : "Not searched"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      toggle(attribute, { isFilterable: !attribute.isFilterable })
                    }
                  >
                    {attribute.isFilterable ? "Stop filtering" : "Use as a filter"}
                    <span className="sr-only"> by {attribute.name}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      toggle(attribute, { isSearchable: !attribute.isSearchable })
                    }
                  >
                    {attribute.isSearchable ? "Stop searching" : "Search it"}
                    <span className="sr-only"> {attribute.name}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={pending}
                    onClick={() => remove(attribute.id, attribute.name)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {inherited.length > 0 ? (
        <div>
          <h3 className="font-display text-h3 text-ink">Inherited</h3>
          <p className="mt-1 text-meta text-ink/70">
            Defined further up the tree, and asked of products here too. Change
            them on the category that owns them.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {inherited.map((attribute) => (
              <li
                key={attribute.id}
                className="rounded-control border border-blue-300 px-3 py-1 text-meta text-ink/70"
              >
                {attribute.name} · {attribute.categoryName}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        onSubmit={add}
        className="flex flex-col gap-4 border-t border-blue-300 pt-6"
        noValidate
      >
        <h3 className="font-display text-h3 text-ink">Add a specification</h3>

        <div className="flex flex-col gap-2">
          <label htmlFor="attributeName" className="text-meta font-medium text-ink">
            What it is called
          </label>
          <input
            id="attributeName"
            value={name}
            required
            placeholder="Refresh rate"
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="attributeType" className="text-meta font-medium text-ink">
              Kind of value
            </label>
            <select
              id="attributeType"
              value={dataType}
              onChange={(event) => setDataType(event.target.value)}
              className={inputClass}
            >
              {TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="attributeUnit" className="text-meta font-medium text-ink">
              Unit
            </label>
            <input
              id="attributeUnit"
              value={unit}
              placeholder="Hz"
              onChange={(event) => setUnit(event.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {needsOptions ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="attributeOptions" className="text-meta font-medium text-ink">
              Choices
            </label>
            <input
              id="attributeOptions"
              value={options}
              placeholder="Small, Medium, Large"
              onChange={(event) => setOptions(event.target.value)}
              className={inputClass}
            />
            <p className="text-meta text-ink/70">Separated by commas.</p>
          </div>
        ) : null}

        <label className="flex min-h-11 items-center gap-3 text-body text-ink">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
            className="size-4"
          />
          Every product here must answer this
        </label>

        <label className="flex min-h-11 items-center gap-3 text-body text-ink">
          <input
            type="checkbox"
            checked={filterableShown}
            onChange={(event) => setFilterable(event.target.checked)}
            className="size-4"
          />
          Offer it as a filter on listings
        </label>

        <label className="flex min-h-11 items-center gap-3 text-body text-ink">
          <input
            type="checkbox"
            checked={searchable}
            onChange={(event) => setSearchable(event.target.checked)}
            className="size-4"
          />
          Let the site&rsquo;s search match its values
        </label>

        <div aria-live="polite" className="min-h-6">
          {error ? (
            <p className="flex items-start gap-2 text-meta text-stamp-red-text">
              <IconAlert size={15} className="mt-0.5 shrink-0" />
              {error}
            </p>
          ) : message ? (
            <p className="flex items-center gap-2 text-meta text-transit-green-text">
              <IconCheck size={15} className="shrink-0" />
              {message}
            </p>
          ) : null}
        </div>

        <div>
          <Button type="submit" disabled={pending || !categoryId}>
            {pending ? "Saving…" : "Add specification"}
          </Button>
        </div>
      </form>
    </div>
  );
}
