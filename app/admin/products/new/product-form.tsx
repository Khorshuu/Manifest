"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";

type CategoryOption = { id: string; label: string };

export function ProductForm({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
        descriptionHtml: form.get("descriptionHtml") || undefined,
        bulletFeatures: bullets.length > 0 ? bullets : undefined,
        status: form.get("status"),
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    router.push("/admin/products");
    router.refresh();
  }

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

      <Field label="Brand" name="brand" />

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
        {error ? <p className="text-meta text-stamp-red">{error}</p> : null}
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save product"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push("/admin/products")}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
