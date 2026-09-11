"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  cleanList,
  CountedInput,
  inputClass,
  LabelledField,
  ListEditor,
  orNull,
  SaveRow,
  useProductSave,
} from "../editor-parts";

/**
 * The search listing, with a preview of the result it produces.
 *
 * Writing a meta description blind is how you end up with a truncated one, so
 * the preview shows the fallbacks too: an empty meta title is not an empty
 * search result, it is the product title.
 */

export type SeoSectionValues = {
  id: string;
  title: string;
  slug: string;
  seoMetaTitle: string | null;
  seoMetaDescription: string | null;
  searchKeywords: string[];
  tags: string[];
  seoNoIndex: boolean;
  canonicalUrl: string | null;
  searchable: boolean;
  searchBoost: number;
};

/**
 * The staff nudge, in words. Five steps rather than a number field: the
 * ranking only uses it to reorder products that are already equally relevant,
 * and a free number invites the belief that 100 beats a better match.
 */
const PRIORITIES = [
  { value: 2, label: "Promote — first among equals" },
  { value: 1, label: "Raise" },
  { value: 0, label: "Normal" },
  { value: -1, label: "Lower" },
  { value: -2, label: "Bury — last among equals" },
] as const;

export function SeoSection({ product }: { product: SeoSectionValues }) {
  const router = useRouter();
  const { save, pending, error, message, dirty, markDirty } = useProductSave(
    product.id,
    () => router.refresh(),
  );

  const [metaTitle, setMetaTitle] = useState(product.seoMetaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(
    product.seoMetaDescription ?? "",
  );
  const [slug, setSlug] = useState(product.slug);
  const [keywords, setKeywords] = useState(product.searchKeywords);
  const [tags, setTags] = useState(product.tags);
  const [noIndex, setNoIndex] = useState(product.seoNoIndex);
  const [canonical, setCanonical] = useState(product.canonicalUrl ?? "");
  const [searchable, setSearchable] = useState(product.searchable);
  const [boost, setBoost] = useState(product.searchBoost);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const saved = await save({
      seoMetaTitle: orNull(metaTitle),
      seoMetaDescription: orNull(metaDescription),
      // Sent only when it changed: rebuilding the same slug is a no-op, but
      // sending one is how an address gets changed by accident.
      ...(slug.trim() !== product.slug ? { slug: slug.trim() } : {}),
      searchKeywords: cleanList(keywords) ?? [],
      tags: cleanList(tags) ?? [],
      seoNoIndex: noIndex,
      canonicalUrl: orNull(canonical),
      searchable,
      searchBoost: boost,
    });

    if (saved && slug.trim() !== product.slug) router.refresh();
  }

  const shownTitle = metaTitle.trim() || product.title;
  const shownDescription =
    metaDescription.trim() ||
    "No description yet — search engines will invent one.";

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-6" noValidate>
      <CountedInput
        id="seoMetaTitle"
        label="SEO title"
        value={metaTitle}
        onChange={(value) => {
          setMetaTitle(value);
          markDirty();
        }}
        ideal={60}
        hint="Falls back to the product name when empty."
      />

      <CountedInput
        id="seoMetaDescription"
        label="Meta description"
        value={metaDescription}
        onChange={(value) => {
          setMetaDescription(value);
          markDirty();
        }}
        ideal={155}
        multiline
      />

      <LabelledField
        label="Address"
        htmlFor="slug"
        hint="Built from the product name. Changing it changes the link — old links stop working."
      >
        <div className="flex items-center gap-2">
          <span className="text-meta text-ink/70">/products/</span>
          <input
            id="slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              markDirty();
            }}
            className={inputClass}
          />
        </div>
      </LabelledField>

      <section
        aria-label="Search result preview"
        className="rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]"
      >
        <p className="text-meta text-ink/70">Preview</p>
        <p className="mt-2 truncate text-body text-blue-600">{shownTitle}</p>
        <p className="text-meta text-transit-green-text">
          /products/{slug || product.slug}
        </p>
        <p className="mt-1 text-meta text-ink/80">{shownDescription}</p>
      </section>

      <fieldset className="flex flex-col gap-4 rounded-card border border-blue-300 bg-paper-raised p-4">
        <legend className="px-1 text-meta font-semibold text-ink">
          On this site&rsquo;s search
        </legend>

        <label className="flex min-h-11 items-center gap-3 text-body text-ink">
          <input
            type="checkbox"
            checked={searchable}
            onChange={(event) => {
              setSearchable(event.target.checked);
              markDirty();
            }}
            className="size-4"
          />
          Show this product in search results and suggestions
        </label>
        <p className="-mt-2 text-meta text-ink/70">
          Off only stops the search box finding it. The product page, the
          category listings and the cart keep working.
        </p>

        <LabelledField
          label="Search priority"
          htmlFor="searchBoost"
          hint="Moves this product up or down among results that are equally relevant. It never lifts a weak match above a strong one."
        >
          <select
            id="searchBoost"
            value={boost}
            onChange={(event) => {
              setBoost(Number(event.target.value));
              markDirty();
            }}
            className={inputClass}
          >
            {PRIORITIES.map((priority) => (
              <option key={priority.value} value={priority.value}>
                {priority.label}
              </option>
            ))}
          </select>
        </LabelledField>

        <ListEditor
          label="Search keywords"
          hint="Words shoppers might type that the listing does not say — “air pods” for AirPods, a common misspelling, a local name. Searched as strongly as the brand; never shown."
          items={keywords}
          placeholder="noise cancelling"
          onChange={(items) => {
            setKeywords(items);
            markDirty();
          }}
          addLabel="Add a keyword"
        />
      </fieldset>

      <ListEditor
        label="Tags"
        hint="Shown to shoppers and used for related products."
        items={tags}
        placeholder="audio"
        onChange={(items) => {
          setTags(items);
          markDirty();
        }}
        addLabel="Add a tag"
      />

      <LabelledField
        label="Canonical link"
        htmlFor="canonicalUrl"
        hint="Leave empty to use this product's own address, which is almost always right."
      >
        <input
          id="canonicalUrl"
          type="url"
          value={canonical}
          onChange={(event) => {
            setCanonical(event.target.value);
            markDirty();
          }}
          className={inputClass}
        />
      </LabelledField>

      <label className="flex min-h-11 items-center gap-3 text-body text-ink">
        <input
          type="checkbox"
          checked={noIndex}
          onChange={(event) => {
            setNoIndex(event.target.checked);
            markDirty();
          }}
          className="size-4"
        />
        Ask search engines not to index this product
      </label>

      <SaveRow pending={pending} dirty={dirty} error={error} message={message} />
    </form>
  );
}
