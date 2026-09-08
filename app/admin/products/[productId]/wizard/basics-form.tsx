"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";

export type BasicsValues = {
  id: string;
  title: string;
  brand: string | null;
  categoryId: string;
  status: string;
  descriptionHtml: string | null;
  bulletFeatures: string[];
  /** Carried through untouched — updateProduct writes every column. */
  seoMetaTitle: string | null;
  seoMetaDescription: string | null;
  specTable: { label: string; value: string }[] | null;
  tags: string[] | null;
};

export function BasicsForm({
  product,
  categories,
  nextHref,
}: {
  product: BasicsValues;
  categories: { id: string; label: string }[];
  nextHref: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

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
        title: String(form.get("title") ?? ""),
        categoryId: form.get("categoryId"),
        brand: text("brand"),
        descriptionHtml: text("descriptionHtml"),
        bulletFeatures: bullets.length > 0 ? bullets : undefined,
        // Fields this step does not edit, sent back so they survive the write.
        seoMetaTitle: product.seoMetaTitle ?? undefined,
        seoMetaDescription: product.seoMetaDescription ?? undefined,
        specTable: product.specTable ?? undefined,
        tags: product.tags ?? undefined,
        status: product.status,
      }),
    });

    if (!response.ok) {
      setPending(false);
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    router.push(nextHref);
    router.refresh();
  }

  return (
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
          defaultValue={product.bulletFeatures.join("\n")}
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
          defaultValue={product.descriptionHtml ?? ""}
          className="rounded-control border border-blue-300 bg-paper p-3 text-body text-ink"
        />
      </div>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save and continue"}
        </Button>
      </div>
    </form>
  );
}
