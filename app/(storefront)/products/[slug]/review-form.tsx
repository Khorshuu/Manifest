"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

/**
 * Only rendered for someone who has actually received this product. The server
 * checks that again on submit — this component decides what is shown, never
 * who is allowed (docs/SECURITY.md).
 */
export function ReviewForm({ productId }: { productId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);

    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId,
        rating: Number(form.get("rating")),
        title: String(form.get("title") ?? "").trim() || undefined,
        body: String(form.get("body") ?? "").trim() || undefined,
      }),
    });

    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "Something went wrong. Try again.");
      return;
    }

    setDone(true);
    router.refresh();
  }

  if (done) {
    return (
      <p className="border border-transit-green p-4 text-body text-ink">
        Thank you. Your review is with us and appears here once someone has read
        it.
      </p>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex max-w-xl flex-col gap-4 border border-blue-300 p-4"
      noValidate
    >
      <h3 className="font-display text-h3 text-ink">Write a review</h3>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-meta font-medium text-ink">Rating</legend>
        <div className="flex flex-wrap gap-3">
          {[5, 4, 3, 2, 1].map((value) => (
            <label
              key={value}
              className="inline-flex min-h-11 items-center gap-2 rounded-control border border-blue-300 px-3 text-body text-ink"
            >
              <input
                type="radio"
                name="rating"
                value={value}
                defaultChecked={value === 5}
              />
              {value}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor="review-title" className="text-meta font-medium text-ink">
          Headline
        </label>
        <input
          id="review-title"
          name="title"
          className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="review-body" className="text-meta font-medium text-ink">
          What should other shoppers know?
        </label>
        <textarea
          id="review-body"
          name="body"
          rows={5}
          className="rounded-control border border-blue-300 bg-paper p-3 text-body text-ink"
        />
      </div>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Submit review"}
        </Button>
      </div>
    </form>
  );
}
