"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

export type GalleryImage = {
  id: string;
  url: string;
  altText: string;
};

export function ImageManager({
  productId,
  images,
}: {
  productId: string;
  images: GalleryImage[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);

    const form = event.currentTarget;
    const data = new FormData(form);

    const response = await fetch(`/api/admin/products/${productId}/images`, {
      method: "POST",
      // No content-type header: the browser sets the multipart boundary.
      body: data,
    });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    form.reset();
    setMessage("Photograph added.");
    router.refresh();
  }

  async function mutate(body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/admin/products/${productId}/images`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "Something went wrong. Try again.");
      return;
    }

    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {images.length > 0 ? (
        <ul className="flex flex-wrap gap-4">
          {images.map((image, index) => (
            <li key={image.id} className="flex w-40 flex-col gap-2">
              {/* Local uploads; next/image arrives with the R2 integration. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.altText}
                width={160}
                height={160}
                className="size-40 rounded-card border border-blue-300 object-cover"
              />
              <p className="text-meta text-ink/70">{image.altText}</p>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending || index === 0}
                  onClick={() =>
                    mutate({
                      action: "reorder",
                      imageId: image.id,
                      direction: "up",
                    })
                  }
                  className="min-h-11 rounded-control border border-blue-300 px-2 text-meta text-blue-600 disabled:opacity-40"
                >
                  Move up
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    mutate({ action: "remove", imageId: image.id })
                  }
                  className="min-h-11 rounded-control border border-blue-300 px-2 text-meta text-stamp-red disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-ink/70">
          No photography yet. The first image is the one shown on the product
          card and at the top of the product page.
        </p>
      )}

      <form onSubmit={upload} className="flex max-w-md flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="file" className="text-meta font-medium text-ink">
            Photograph
          </label>
          <input
            id="file"
            name="file"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            required
            className="min-h-11 rounded-control border border-blue-300 px-3 py-2 text-body"
          />
          <p className="text-meta text-ink/70">
            JPEG, PNG, WebP, or AVIF, under 5MB. Square, on a plain ground.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="altText" className="text-meta font-medium text-ink">
            Describe the photograph
          </label>
          <input
            id="altText"
            name="altText"
            required
            placeholder="Open-back headphones, three-quarter view"
            className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
          />
          <p className="text-meta text-ink/70">
            Describe the product, not the file. This is what someone using a
            screen reader hears.
          </p>
        </div>

        <div aria-live="polite" className="flex flex-col gap-1">
          {error ? <p className="text-meta text-stamp-red">{error}</p> : null}
          {message ? (
            <p className="text-meta text-transit-green">{message}</p>
          ) : null}
        </div>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Uploading…" : "Add photograph"}
          </Button>
        </div>
      </form>
    </div>
  );
}
