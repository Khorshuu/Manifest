"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { IconAlert, IconCheck, IconPlus } from "@/components/icons";
import {
  CROP_ACCEPTED_TYPES,
  MAX_SOURCE_BYTES,
  ratioLabel,
} from "@/lib/images/crop";
import { decodeImage, releaseSource, type CropSource } from "@/lib/images/browser";
import { CropEditor, type CropResult } from "./crop-editor";

export type GalleryImage = {
  id: string;
  url: string;
  altText: string;
};

/** One image open in the crop editor. */
type Session = {
  key: number;
  source: CropSource;
  fileName: string;
  mode: "add" | "replace" | "edit";
  imageId: string | null;
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
 * Every image goes through the crop editor before it is saved (D-049): drop
 * or choose any number of files, and each opens in turn at 4:5, to be framed,
 * described and saved. Edit re-opens a saved image; Replace swaps its file
 * for a new one. Both keep the image's place in the order.
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
  const [editing, setEditing] = useState<string | null>(null);
  const [altDraft, setAltDraft] = useState("");
  /** The order shown while a drag is in progress, before the server has it. */
  const [order, setOrder] = useState<GalleryImage[] | null>(null);
  const dragFrom = useRef<number | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [queue, setQueue] = useState<File[]>([]);
  const [batch, setBatch] = useState<{ index: number; total: number; saved: number } | null>(
    null,
  );
  const [opening, setOpening] = useState(false);
  const [dropping, setDropping] = useState(false);
  /** Each saved image's shape, read from the file itself once it loads. */
  const [ratios, setRatios] = useState<Record<string, string>>({});
  const sessionKey = useRef(0);

  const shown = order ?? images;
  const isGallery = kind === "gallery";
  const noun = isGallery ? "photograph" : "lifestyle image";
  const Noun = `${noun[0].toUpperCase()}${noun.slice(1)}`;
  const inputId = `file-${kind}`;

  /** Opens one file in the editor, or says plainly why it cannot. */
  async function open(
    file: Blob & { name?: string },
    mode: Session["mode"],
    imageId: string | null = null,
    altText = "",
  ): Promise<boolean> {
    const name = file.name ?? "image";
    if (!(CROP_ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
      setError(`${name} is not a JPEG, PNG, WebP or AVIF image.`);
      return false;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError(`${name} is larger than ${MAX_SOURCE_BYTES / (1024 * 1024)}MB.`);
      return false;
    }

    setOpening(true);
    try {
      const source = await decodeImage(file);
      sessionKey.current += 1;
      setSession({ key: sessionKey.current, source, fileName: name, mode, imageId, altText });
      return true;
    } catch {
      setError(`${name} could not be read as an image.`);
      return false;
    } finally {
      setOpening(false);
    }
  }

  /** Works through the next file in a batch, skipping any that cannot open. */
  async function openNext(files: File[], index: number, total: number, saved: number) {
    let remaining = files;
    let position = index;
    while (remaining.length > 0) {
      const [next, ...rest] = remaining;
      remaining = rest;
      setBatch({ index: position, total, saved });
      setQueue(rest);
      if (await open(next, "add")) return;
      position += 1;
    }
    finishBatch(total, saved);
  }

  function finishBatch(total: number, saved: number) {
    setSession(null);
    setQueue([]);
    setBatch(null);
    if (total > 1 && saved > 0) {
      setMessage(`${saved} ${noun}${saved === 1 ? "" : "s"} added.`);
    }
  }

  function start(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setMessage(null);
    void openNext(files, 1, files.length, 0);
  }

  async function openExisting(image: GalleryImage) {
    setError(null);
    setMessage(null);
    setOpening(true);
    try {
      const response = await fetch(image.url);
      if (!response.ok) throw new Error("unreadable");
      const blob = await response.blob();
      setOpening(false);
      await open(blob, "edit", image.id, image.altText);
    } catch {
      setOpening(false);
      setError(
        `This ${noun} could not be opened for editing. Use Replace to upload the original instead.`,
      );
    }
  }

  /*
   * A decoded image is freed once the editor showing it has gone — when the
   * next image opens or the editor closes. Freeing it any earlier breaks the
   * editor's last redraw, which still reads it.
   */
  useEffect(() => {
    const source = session?.source;
    return () => releaseSource(source);
  }, [session]);

  async function save(result: CropResult): Promise<string | null> {
    if (!session) return "Nothing is open.";

    const extension = result.blob.type === "image/webp" ? "webp" : "jpg";
    const base = session.fileName.replace(/\.[^.]+$/, "").slice(0, 60) || "image";
    const data = new FormData();
    data.set("file", new File([result.blob], `${base}.${extension}`, { type: result.blob.type }));
    data.set("altText", result.altText);
    data.set("kind", kind);
    if (session.imageId) data.set("replaceImageId", session.imageId);

    const response = await fetch(`/api/admin/products/${productId}/images`, {
      // No content-type header: the browser sets the multipart boundary.
      method: "POST",
      body: data,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return body.error ?? "Something went wrong. Try again.";
    }

    router.refresh();

    if (session.mode !== "add") {
      setSession(null);
      setMessage(`${Noun} updated.`);
      return null;
    }

    setMessage(`${Noun} added.`);
    const current = batch ?? { index: 1, total: 1, saved: 0 };
    const saved = current.saved + 1;
    if (queue.length > 0) {
      void openNext(queue, current.index + 1, current.total, saved);
    } else {
      finishBatch(current.total, saved);
    }
    return null;
  }

  function cancel() {
    const current = batch;
    if (current && queue.length > 0) {
      void openNext(queue, current.index + 1, current.total, current.saved);
    } else if (current) {
      finishBatch(current.total, current.saved);
    } else {
      setSession(null);
    }
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

  const tileButton =
    "inline-flex min-h-10 items-center justify-center rounded-control border border-blue-300 px-1.5 text-[0.75rem] font-medium text-blue-600 transition-colors hover:border-blue-500 hover:bg-blue-50 disabled:opacity-40";

  const heading =
    session?.mode === "edit"
      ? `Edit ${noun}`
      : session?.mode === "replace"
        ? `Replace ${noun}`
        : `Add ${noun}`;

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
              <div className="relative aspect-[4/5] overflow-hidden rounded-control bg-blue-50">
                {/* The whole image, uncropped, so its real shape shows. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt={image.altText}
                  width={160}
                  height={200}
                  draggable={false}
                  onLoad={(event) => {
                    const { naturalWidth, naturalHeight } = event.currentTarget;
                    if (!naturalWidth || !naturalHeight) return;
                    const label = ratioLabel(naturalWidth, naturalHeight);
                    setRatios((current) =>
                      current[image.id] === label ? current : { ...current, [image.id]: label },
                    );
                  }}
                  className="size-full object-contain"
                />
                {isGallery && index === 0 ? (
                  <span className="absolute left-1.5 top-1.5 rounded-[6px] bg-ink/85 px-1.5 py-0.5 text-[0.6875rem] font-bold text-paper">
                    Primary
                  </span>
                ) : null}
                {ratios[image.id] ? (
                  <span className="absolute right-1.5 top-1.5 rounded-[6px] bg-paper/90 px-1.5 py-0.5 text-[0.6875rem] font-bold tabular-nums text-ink shadow-[var(--shadow-raise)]">
                    {ratios[image.id]}
                  </span>
                ) : null}
              </div>

              <p className="line-clamp-2 text-meta text-ink/70">
                {isGallery && index === 0 ? (
                  <span className="mr-1 font-semibold text-brass-text">Main ·</span>
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
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    disabled={pending || opening}
                    onClick={() => openExisting(image)}
                    className={tileButton}
                  >
                    Edit
                    <span className="sr-only"> crop of {image.altText}</span>
                  </button>
                  <label className={`${tileButton} cursor-pointer`}>
                    Replace
                    <input
                      type="file"
                      accept={CROP_ACCEPTED_TYPES.join(",")}
                      aria-label={`Replace ${noun} ${index + 1}`}
                      disabled={pending || opening}
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (!file) return;
                        setError(null);
                        setMessage(null);
                        void open(file, "replace", image.id, image.altText);
                      }}
                    />
                  </label>
                  {isGallery ? (
                    <button
                      type="button"
                      disabled={pending || index === 0}
                      onClick={() => mutate({ action: "promote", imageId: image.id })}
                      className={tileButton}
                    >
                      Make main
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setEditing(image.id);
                      setAltDraft(image.altText);
                    }}
                    className={tileButton}
                  >
                    Describe
                  </button>
                  <button
                    type="button"
                    disabled={pending || index === 0}
                    onClick={() =>
                      mutate({ action: "reorder", imageId: image.id, direction: "up" })
                    }
                    className={tileButton}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    disabled={pending || index === shown.length - 1}
                    onClick={() =>
                      mutate({ action: "reorder", imageId: image.id, direction: "down" })
                    }
                    className={tileButton}
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => mutate({ action: "remove", imageId: image.id })}
                    className={`${tileButton} col-span-2 text-stamp-red-text`}
                  >
                    Delete
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

      {/*
       * The upload area. Files dropped here or chosen with browse open in the
       * crop editor one after another; nothing is uploaded until each is
       * framed and saved there.
       */}
      <div
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDropping(false);
          start([...event.dataTransfer.files]);
        }}
        className={`flex max-w-2xl flex-col items-center gap-2 rounded-card border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dropping ? "border-blue-600 bg-blue-50" : "border-blue-300 bg-paper"
        }`}
      >
        <span
          aria-hidden="true"
          className="inline-flex size-10 items-center justify-center rounded-full bg-blue-50 text-blue-600"
        >
          <IconPlus size={20} />
        </span>
        <p className="text-body text-ink">
          Drop {isGallery ? "product images" : "lifestyle images"} here or{" "}
          <label htmlFor={inputId} className="cursor-pointer font-semibold text-blue-600 underline underline-offset-4">
            browse
          </label>
        </p>
        <p className="text-meta text-ink/70">
          JPEG, PNG, WebP or AVIF, any shape. You crop each one before it is saved —
          4:5 is the product standard.
        </p>
        <input
          id={inputId}
          type="file"
          multiple
          accept={CROP_ACCEPTED_TYPES.join(",")}
          aria-label={isGallery ? "Photograph" : "Lifestyle image"}
          disabled={opening || session !== null}
          className="sr-only"
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            start(files);
          }}
        />
      </div>

      <div aria-live="polite" className="flex flex-col gap-1">
        {opening ? <p className="text-meta text-ink/70">Opening the editor…</p> : null}
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

      {session ? (
        <CropEditor
          key={session.key}
          source={session.source}
          heading={heading}
          noun={noun}
          confirmLabel={session.mode === "add" ? `Add ${noun}` : `Save ${noun}`}
          initialAlt={session.altText}
          altRequired={session.mode === "add"}
          progress={
            batch && batch.total > 1 ? `Image ${batch.index} of ${batch.total}` : null
          }
          onCancel={cancel}
          onConfirm={save}
        />
      ) : null}
    </div>
  );
}
