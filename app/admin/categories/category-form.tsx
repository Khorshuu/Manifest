"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import { slugify } from "@/lib/slug";

type ParentOption = { id: string; label: string };

export function CategoryForm({ parents }: { parents: ParentOption[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const parentId = form.get("parentId");

    const response = await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        slug: form.get("slug"),
        parentId: parentId ? String(parentId) : null,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    (event.target as HTMLFormElement).reset();
    setSlug("");
    setSlugTouched(false);
    setPending(false);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <Field
        label="Name"
        name="name"
        required
        onChange={(event) => {
          // The slug follows the name until someone edits it by hand.
          if (!slugTouched) setSlug(slugify(event.target.value));
        }}
      />

      <Field
        label="Slug"
        name="slug"
        required
        value={slug}
        onChange={(event) => {
          setSlugTouched(true);
          setSlug(event.target.value);
        }}
        hint="Appears in the category URL."
      />

      <div className="flex flex-col gap-2">
        <label htmlFor="parentId" className="text-meta font-medium text-ink">
          Parent category
        </label>
        <select
          id="parentId"
          name="parentId"
          defaultValue=""
          className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
        >
          <option value="">None — this is a top-level category</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {parent.label}
            </option>
          ))}
        </select>
      </div>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red">{error}</p> : null}
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add category"}
      </Button>
    </form>
  );
}
