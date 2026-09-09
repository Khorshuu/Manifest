"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import type { BasicsValues } from "./basics-form";

/**
 * The search listing, with a preview of the result it produces. Writing a meta
 * description blind is how you end up with a truncated one.
 */
export function SeoForm({
  product,
  nextHref,
}: {
  product: BasicsValues & { slug: string };
  nextHref: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(product.seoMetaTitle ?? "");
  const [description, setDescription] = useState(
    product.seoMetaDescription ?? "",
  );

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const response = await fetch(`/api/admin/products/${product.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: product.title,
        categoryId: product.categoryId,
        brand: product.brand ?? undefined,
        descriptionHtml: product.descriptionHtml ?? undefined,
        bulletFeatures:
          product.bulletFeatures.length > 0 ? product.bulletFeatures : undefined,
        seoMetaTitle: title.trim() || undefined,
        seoMetaDescription: description.trim() || undefined,
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

  const shownTitle = title.trim() || product.title;
  const shownDescription =
    description.trim() || "No description yet — search engines will invent one.";

  return (
    <form onSubmit={save} className="flex max-w-2xl flex-col gap-6" noValidate>
      <Field
        label="Meta title"
        name="seoMetaTitle"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        hint="Falls back to the product title when empty. Around 60 characters shows in full."
      />

      <div className="flex flex-col gap-2">
        <label
          htmlFor="seoMetaDescription"
          className="text-meta font-medium text-ink"
        >
          Meta description
        </label>
        <textarea
          id="seoMetaDescription"
          name="seoMetaDescription"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="rounded-control border border-blue-300 bg-paper p-3 text-body text-ink"
        />
        <p className="text-meta text-ink/70">
          {description.length} characters. Around 155 shows in full.
        </p>
      </div>

      <section aria-label="Search result preview" className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
        <p className="text-meta text-ink/70">Preview</p>
        <p className="mt-2 truncate text-body text-blue-600">{shownTitle}</p>
        <p className="text-meta text-transit-green-text">/products/{product.slug}</p>
        <p className="mt-1 text-meta text-ink/80">{shownDescription}</p>
      </section>

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
