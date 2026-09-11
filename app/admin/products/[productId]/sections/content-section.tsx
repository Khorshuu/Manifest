"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  areaClass,
  cleanList,
  LabelledField,
  ListEditor,
  orNull,
  SaveRow,
  useProductSave,
} from "../editor-parts";

/**
 * What the listing says about itself: the description, the highlights at the
 * top of the buy box, and what is in the box.
 *
 * The description is HTML, written by staff only — customers cannot create
 * listings — and the toolbar below writes the small set of tags the product
 * page renders. There is no third-party editor here on purpose: adding one
 * would mean shipping a sanitiser for whatever else it can produce.
 */

const ALLOWED_HINT =
  "Paragraphs, headings, lists, bold, italic and links. Written by staff only.";

export type ContentSectionValues = {
  id: string;
  descriptionHtml: string | null;
  bulletFeatures: string[];
  boxContents: string[];
};

export function ContentSection({ product }: { product: ContentSectionValues }) {
  const router = useRouter();
  const { save, pending, error, message, dirty, markDirty } = useProductSave(
    product.id,
    () => router.refresh(),
  );

  const [description, setDescription] = useState(product.descriptionHtml ?? "");
  const [highlights, setHighlights] = useState(product.bulletFeatures);
  const [contents, setContents] = useState(product.boxContents);

  /** Wraps the selection in a tag, which is what a formatting button is. */
  function wrap(open: string, close: string) {
    const field = document.getElementById(
      "descriptionHtml",
    ) as HTMLTextAreaElement | null;
    if (!field) return;

    const { selectionStart: start, selectionEnd: end, value } = field;
    const next =
      value.slice(0, start) +
      open +
      value.slice(start, end) +
      close +
      value.slice(end);

    setDescription(next);
    markDirty();

    // Put the caret back inside what was just wrapped, or the writer has to
    // find their place again after every button press.
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + open.length, end + open.length);
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await save({
      descriptionHtml: orNull(description),
      bulletFeatures: cleanList(highlights) ?? [],
      boxContents: cleanList(contents) ?? [],
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-8" noValidate>
      <ListEditor
        label="Key features"
        hint="Shown at the top of the product page, in this order. Short claims work best."
        items={highlights}
        placeholder="Sourced direct from the US"
        onChange={(items) => {
          setHighlights(items);
          markDirty();
        }}
        addLabel="Add a feature"
      />

      <LabelledField
        label="Description"
        htmlFor="descriptionHtml"
        hint={ALLOWED_HINT}
      >
        <div className="flex flex-wrap gap-2">
          {[
            { label: "Heading", open: "<h3>", close: "</h3>" },
            { label: "Paragraph", open: "<p>", close: "</p>" },
            { label: "Bold", open: "<strong>", close: "</strong>" },
            { label: "Italic", open: "<em>", close: "</em>" },
            { label: "List", open: "<ul>\n  <li>", close: "</li>\n</ul>" },
            { label: "Link", open: '<a href="https://">', close: "</a>" },
          ].map((tag) => (
            <button
              key={tag.label}
              type="button"
              onClick={() => wrap(tag.open, tag.close)}
              className="min-h-11 rounded-control border border-blue-300 px-3 text-meta text-blue-600 transition-colors hover:bg-blue-50"
            >
              {tag.label}
            </button>
          ))}
        </div>
        <textarea
          id="descriptionHtml"
          name="descriptionHtml"
          rows={10}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            markDirty();
          }}
          className={`${areaClass} font-mono text-meta`}
        />
      </LabelledField>

      <ListEditor
        label="What's included"
        hint="One line per item — the product page lists these under What's in the box."
        items={contents}
        placeholder="1 x charging cable"
        onChange={(items) => {
          setContents(items);
          markDirty();
        }}
        addLabel="Add an item"
      />

      <SaveRow pending={pending} dirty={dirty} error={error} message={message} />
    </form>
  );
}
