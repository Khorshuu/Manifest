"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { IconAlert, IconCheck } from "@/components/icons";

export type GalleryImage = {
  id: string;
  url: string;
  altText: string;
};

/**
 * The photography for one product, in the order it will be shown.
 *
 * Order matters twice over: the first image is the main one everywhere else
 * on the site, and the rest are the thumbnails a shopper clicks through. So
 * this offers three ways to change it — drag, the arrow buttons, and "Make
 * main" — because dragging is fastest with a mouse and impossible without one.
 *
 * `kind` keeps the two galleries apart. The component is the same; the server
 * orders each kind independently, so adding a lifestyle shot never disturbs
 * the main image.
 */
export function ImageManager({
  productId,
  images,
  kind = "gallery",
}: {
  productId: string;
  images: GalleryImage[];
  kind?: "gallery" | "lifestyle";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [altDraft, setAltDraft] = useState("");
  /** The order shown while a drag is in progress, before the server has it. */
  const [order, setOrder] = useState<GalleryImage[] | null>(null);
  const dragFrom = useRef<number | null>(null);

  const shown = order ?? images;
  const isGallery = kind === "gallery";
  const noun = isGallery ? "photograph" : "lifestyle image";

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    data.set("kind", kind);

    const response = await fetch(`/api/admin/products/${productId}/images`, {
      // No content-type header: the browser sets the multipart boundary.
      method: "POST",
      body: data,
    });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    form.reset();
    setPreview(null);
    setMessage(`${noun[0].toUpperCase()}${noun.slice(1)} added.`);
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
      // The optimistic order is dropped, so the screen goes back to the truth.
      setOrder(null);
      router.refresh();
      return false;
    }

    router.refresh();
    return true;
  }

  function onDrop(to: number) {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;

    const next = [...shown];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);

    // Shown immediately, then confirmed: a gallery that snaps back for a
    // moment on every drop reads as broken even when the save succeeded.
    setOrder(next);
    void mutate({ action: "order", imageIds: next.map((image) => image.id) }).then(
      (ok) => {
        if (ok) setOrder(null);
      },
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {shown.length > 0 ? (
        <ul className="flex flex-wrap gap-4">
          {shown.map((image, index) => (
            <li
              key={image.id}
              draggable
              onDragStart={() => {
                dragFrom.current = index;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => onDrop(index)}
              className="flex w-44 cursor-grab flex-col gap-2 rounded-card border border-blue-300 bg-paper p-2 shadow-[var(--shadow-raise)] active:cursor-grabbing"
            >
              {/* Local uploads; next/image arrives with the R2 integration. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.altText}
                width={160}
                height={160}
                className="size-40 rounded-control object-cover"
              />

              <p className="text-meta text-ink/70">
                {isGallery && index === 0 ? (
                  <span className="mr-1 font-semibold text-brass-text">
                    Main ·
                  </span>
                ) : null}
                {image.altText}
              </p>

              {editing === image.id ? (
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor={`alt-${image.id}`}
                    className="text-meta font-medium text-ink"
                  >
                    Description
                  </label>
                  <input
                    id={`alt-${image.id}`}
                    value={altDraft}
                    onChange={(event) => setAltDraft(event.target.value)}
                    className="min-h-11 w-full rounded-control border border-blue-300 px-2 text-meta"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending}
                      onClick={async () => {
                        const ok = await mutate({
                          action: "alt",
                          imageId: image.id,
                          altText: altDraft,
                        });
                        if (ok) setEditing(null);
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {isGallery ? (
                    <button
                      type="button"
                      disabled={pending || index === 0}
                      onClick={() =>
                        mutate({ action: "promote", imageId: image.id })
                      }
                      className="min-h-11 rounded-control border border-blue-300 px-2 text-meta text-blue-600 disabled:opacity-40"
                    >
                      Make main
                    </button>
                  ) : null}
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
                    disabled={pending || index === shown.length - 1}
                    onClick={() =>
                      mutate({
                        action: "reorder",
                        imageId: image.id,
                        direction: "down",
                      })
                    }
                    className="min-h-11 rounded-control border border-blue-300 px-2 text-meta text-blue-600 disabled:opacity-40"
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setEditing(image.id);
                      setAltDraft(image.altText);
                    }}
                    className="min-h-11 rounded-control border border-blue-300 px-2 text-meta text-blue-600 disabled:opacity-40"
                  >
                    Describe
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => mutate({ action: "remove", imageId: image.id })}
                    className="min-h-11 rounded-control border border-blue-300 px-2 text-meta text-stamp-red-text disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-ink/70">
          {isGallery
            ? "No photography yet. The first image is the one shown on the product card and at the top of the product page."
            : "No lifestyle imagery yet. This section stays hidden on the product page until there is some."}
        </p>
      )}

      <form onSubmit={upload} className="flex max-w-md flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label
            htmlFor={`file-${kind}`}
            className="text-meta font-medium text-ink"
          >
            {isGallery ? "Photograph" : "Lifestyle image"}
          </label>
          <input
            id={`file-${kind}`}
            name="file"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            required
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // Shown from the browser's own copy of the file, so there is
              // something to check before anything is uploaded.
              setPreview(file ? URL.createObjectURL(file) : null);
            }}
            className="min-h-11 rounded-control border border-blue-300 px-3 py-2 text-body"
          />
          <p className="text-meta text-ink/70">
            JPEG, PNG, WebP, or AVIF, under 5MB.
            {isGallery ? " Square, on a plain ground." : ""}
          </p>
        </div>

        {preview ? (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt=""
              className="size-24 rounded-control border border-blue-300 object-cover"
            />
            <p className="text-meta text-ink/70">
              This is what will be uploaded.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <label
            htmlFor={`altText-${kind}`}
            className="text-meta font-medium text-ink"
          >
            Describe the {noun}
          </label>
          <input
            id={`altText-${kind}`}
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
          {error ? (
            <p className="flex items-start gap-2 text-meta text-stamp-red-text">
              <IconAlert size={15} className="mt-0.5 shrink-0" />
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="flex items-center gap-2 text-meta text-transit-green-text">
              <IconCheck size={15} className="shrink-0" />
              {message}
            </p>
          ) : null}
        </div>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Uploading…" : `Add ${noun}`}
          </Button>
        </div>
      </form>
    </div>
  );
}
