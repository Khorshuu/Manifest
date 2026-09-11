"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import {
  inputClass,
  LabelledField,
  orNull,
  SaveRow,
  useProductSave,
} from "../editor-parts";
import { ImageManager, type GalleryImage } from "../image-manager";

/**
 * Photography and video.
 *
 * Two galleries, deliberately separate: the product gallery is what the buy
 * box shows, and the lifestyle set is the product in use, which appears far
 * down the page. Mixing them is how a buy box ends up leading with a picture
 * of a desk.
 */
export function MediaSection({
  productId,
  images,
  lifestyleImages,
  videoUrl,
}: {
  productId: string;
  images: GalleryImage[];
  lifestyleImages: GalleryImage[];
  videoUrl: string | null;
}) {
  const router = useRouter();
  const { save, pending, error, message, dirty, markDirty } = useProductSave(
    productId,
    () => router.refresh(),
  );
  const [video, setVideo] = useState(videoUrl ?? "");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await save({ videoUrl: orNull(video) });
  }

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <section className="flex flex-col gap-4">
        <div>
          <h3 className="font-display text-h3 text-ink">Product gallery</h3>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            The first photograph is the main image — it is what the product
            card, the top of the product page and the homepage row all show.
            Drag a photograph to reorder, or use the buttons.
          </p>
        </div>
        <ImageManager productId={productId} images={images} kind="gallery" />
      </section>

      <section className="flex flex-col gap-4 border-t border-blue-300 pt-6">
        <div>
          <h3 className="font-display text-h3 text-ink">Lifestyle imagery</h3>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            The product in use. Shown in its own band below the description,
            and kept out of the buy-box gallery. Nothing appears on the product
            page while this is empty.
          </p>
        </div>
        <ImageManager
          productId={productId}
          images={lifestyleImages}
          kind="lifestyle"
        />
      </section>

      <form
        onSubmit={submit}
        className="flex max-w-2xl flex-col gap-4 border-t border-blue-300 pt-6"
        noValidate
      >
        <h3 className="font-display text-h3 text-ink">Video</h3>

        <LabelledField
          label="Video link"
          htmlFor="videoUrl"
          hint="A YouTube or Vimeo link, or a link to a video file. It appears in the gallery beside the photographs."
        >
          <input
            id="videoUrl"
            type="url"
            value={video}
            placeholder="https://www.youtube.com/watch?v=…"
            onChange={(event) => {
              setVideo(event.target.value);
              markDirty();
            }}
            className={inputClass}
          />
        </LabelledField>

        {video.trim() ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setVideo("");
                markDirty();
              }}
            >
              Remove video
            </Button>
          </div>
        ) : null}

        <SaveRow
          pending={pending}
          dirty={dirty}
          error={error}
          message={message}
          label="Save video"
        />
      </form>
    </div>
  );
}
