"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";

export type EditableProduct = {
  id: string;
  title: string;
  brand: string | null;
  categoryId: string;
  status: string;
  descriptionHtml: string | null;
  bulletFeatures: string[];
  seoMetaTitle: string | null;
  seoMetaDescription: string | null;
  archived: boolean;
  /**
   * Carried through untouched. updateProduct writes every column, so a field
   * this form does not edit has to be sent back or it is nulled out.
   */
  specTable: { label: string; value: string }[] | null;
  tags: string[] | null;
};

export type CategoryOption = { id: string; label: string };

const STATUSES = [
  { value: "draft", label: "Draft — not visible to shoppers" },
  { value: "coming_soon", label: "Coming soon" },
  { value: "preorder_open", label: "Preorder open" },
  { value: "preorder_closed", label: "Preorder closed" },
  { value: "in_stock", label: "In stock" },
  { value: "discontinued", label: "Discontinued" },
] as const;

export function EditProductForm({
  product,
  categories,
}: {
  product: EditableProduct;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = String(form.get(name) ?? "").trim();
      return value.length > 0 ? value : undefined;
    };
    const bullets = String(form.get("bulletFeatures") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const response = await fetch(`/api/admin/products/${product.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Always a string, never dropped: an empty title has to reach the
        // schema so it comes back with the message that says what to do.
        title: String(form.get("title") ?? ""),
        categoryId: form.get("categoryId"),
        brand: text("brand"),
        descriptionHtml: text("descriptionHtml"),
        bulletFeatures: bullets.length > 0 ? bullets : undefined,
        seoMetaTitle: text("seoMetaTitle"),
        seoMetaDescription: text("seoMetaDescription"),
        status: form.get("status"),
        specTable: product.specTable ?? undefined,
        tags: product.tags ?? undefined,
      }),
    });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage("Saved.");
    router.refresh();
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <form onSubmit={save} className="flex max-w-2xl flex-col gap-6" noValidate>
        <Field label="Title" name="title" required defaultValue={product.title} />

        <div className="flex flex-col gap-2">
          <label htmlFor="categoryId" className="text-meta font-medium text-ink">
            Category
          </label>
          <select
            id="categoryId"
            name="categoryId"
            defaultValue={product.categoryId}
            className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </div>

        <Field label="Brand" name="brand" defaultValue={product.brand ?? ""} />

        <div className="flex flex-col gap-2">
          <label htmlFor="status" className="text-meta font-medium text-ink">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={product.status}
            className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
          >
            {/* Only present while archived: the status is set by archiving,
                not chosen here, and an absent option would silently display
                the wrong one. */}
            {product.archived ? (
              <option value="archived">Archived</option>
            ) : null}
            {STATUSES.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="bulletFeatures" className="text-meta font-medium text-ink">
            Key points
          </label>
          <textarea
            id="bulletFeatures"
            name="bulletFeatures"
            rows={4}
            defaultValue={product.bulletFeatures.join("\n")}
            className="rounded-control border border-blue-300 bg-paper p-3 text-body text-ink"
          />
          <p className="text-meta text-ink/70">One per line.</p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="descriptionHtml" className="text-meta font-medium text-ink">
            Description
          </label>
          <textarea
            id="descriptionHtml"
            name="descriptionHtml"
            rows={6}
            defaultValue={product.descriptionHtml ?? ""}
            className="rounded-control border border-blue-300 bg-paper p-3 text-body text-ink"
          />
        </div>

        <fieldset className="flex flex-col gap-5 border-t border-blue-300 pt-6">
          <legend className="text-meta font-medium text-ink">Search listing</legend>

          <Field
            label="Meta title"
            name="seoMetaTitle"
            defaultValue={product.seoMetaTitle ?? ""}
            hint="Falls back to the product title when empty."
          />
          <Field
            label="Meta description"
            name="seoMetaDescription"
            defaultValue={product.seoMetaDescription ?? ""}
            hint="What a search result shows beneath the title."
          />
        </fieldset>

        <div aria-live="polite" className="flex flex-col gap-1">
          {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
          {message ? <p className="text-meta text-transit-green-text">{message}</p> : null}
        </div>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}
