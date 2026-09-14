import Link from "next/link";
import type { CSSProperties } from "react";
import { MediaImage } from "./media-image";
import { IconArrowRight } from "./icons";
import { Stagger, StaggerItem } from "./motion";

export type BentoCategory = {
  id: string;
  name: string;
  slug: string;
  children: { id: string; name: string }[];
  productCount: number;
  imageUrl: string | null;
  imageAlt: string;
};

/**
 * Browse by kind (D-051, redesigned at the owner's request).
 *
 * Image-led cards, each shelf on its own soft ground drawn from the palette —
 * brass, blue, transit green, stamp red — so the row reads as a set of
 * distinct shelves rather than one repeated tile. The photograph is the card:
 * it sits large on that ground, and a frosted strip along the foot carries the
 * name, a live count and an arrow. Behind the photograph is a blurred copy
 * of itself, so each card wears its own colours and nothing is cropped; the
 * palette ground shows only where a shelf has no photograph yet.
 *
 * One board at every width, as the owner asked — the phone is the desktop
 * design at phone size: the first shelf as one tall feature card beside a
 * two-by-two of the rest, about 250px high on a phone and 360–400px from
 * `sm`. On a phone the small cards carry just the name and count.
 *
 * The count is a real query. An empty category says "Nothing open yet" rather
 * than being hidden, because a shopper looking for it should find out it
 * exists and is quiet, not be left wondering.
 */

/** A soft ground per card, built only from palette tokens. */
const GROUNDS = [
  "var(--color-brass)",
  "var(--color-blue-600)",
  "var(--color-transit-green)",
  "var(--color-stamp-red)",
  "var(--color-blue-400)",
];

function groundStyle(index: number): CSSProperties {
  const tone = GROUNDS[index % GROUNDS.length];
  return {
    background: `radial-gradient(90% 70% at 50% 30%, rgb(255 255 255 / 0.9) 0%, transparent 70%), linear-gradient(160deg, color-mix(in srgb, ${tone} 8%, white) 0%, color-mix(in srgb, ${tone} 22%, white) 100%)`,
  };
}

export function CategoryBento({
  categories,
}: {
  categories: BentoCategory[];
}) {
  if (categories.length === 0) return null;

  return (
    <section className="mx-auto w-full max-w-[1280px] px-4 md:px-6">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-3 text-[0.6875rem] uppercase tracking-[0.18em] text-brass-text sm:text-meta">
            <span aria-hidden="true" className="h-px w-6 bg-brass sm:w-8" />
            The shelves
          </p>
          <h2 className="mt-1 font-display text-[1.375rem] leading-tight text-ink sm:mt-2 sm:text-h2">
            Browse by kind
          </h2>
        </div>
        <Link
          href="/search"
          className="group inline-flex shrink-0 items-center gap-1 text-meta font-semibold text-blue-600 underline-offset-4 hover:underline"
        >
          See all
          <IconArrowRight
            size={15}
            className="transition-transform duration-200 ease-[var(--ease-out-quint)] group-hover:translate-x-0.5"
          />
        </Link>
      </div>

      {/*
       * A four-column board, two rows high, the first card spanning both rows
       * and two columns — the same at every width, only the row height and
       * the gaps change.
       */}
      <Stagger className="mt-4 grid grid-cols-4 grid-rows-[repeat(2,7.5rem)] gap-2 sm:mt-5 sm:grid-rows-[repeat(2,9.5rem)] sm:gap-3 lg:grid-rows-[repeat(2,11rem)]">
        {categories.map((category, index) => (
          <StaggerItem
            key={category.id}
            className={`min-w-0 ${index === 0 ? "col-span-2 row-span-2" : ""} ${
              index > 4 ? "hidden" : ""
            }`}
          >
            <CategoryCard category={category} index={index} feature={index === 0} />
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

function CategoryCard({
  category,
  index,
  feature,
}: {
  category: BentoCategory;
  index: number;
  feature: boolean;
}) {
  const count =
    category.productCount === 0
      ? "Nothing open yet"
      : category.productCount === 1
        ? "1 listing"
        : `${category.productCount} listings`;

  return (
    <Link
      href={`/categories/${category.slug}`}
      style={groundStyle(index)}
      className="media-zoom lift group relative flex h-full w-full overflow-hidden rounded-[14px] border border-blue-200/80 shadow-[var(--shadow-raise)] transition-[border-color,box-shadow] hover:border-blue-300 hover:shadow-[var(--shadow-lift)] sm:rounded-[var(--radius-media)]"
    >
      {category.imageUrl ? (
        <>
          {/*
           * The photograph twice: once blurred and enlarged past every edge as
           * the card's ground, so the card takes the photograph's own colours
           * and no backdrop ever shows as a pasted box; and once sharp and whole
           * on top of it, above the label, so nothing of the product is cropped.
           */}
          <span aria-hidden="true" className="absolute inset-0 overflow-hidden">
            <MediaImage
              src={category.imageUrl}
              alt=""
              sizes="160px"
              className="scale-150 object-cover opacity-70 blur-2xl saturate-150"
            />
            <span className="absolute inset-0 bg-paper/35" />
          </span>
          <span
            className={`absolute inset-x-0 top-0 ${
              feature ? "bottom-16 sm:bottom-20" : "bottom-9 sm:bottom-12"
            }`}
          >
            <MediaImage
              src={category.imageUrl}
              alt=""
              sizes={feature ? "(min-width: 640px) 50vw, 44vw" : "(min-width: 640px) 25vw, 44vw"}
              className={`rounded-[14px] object-contain drop-shadow-[0_12px_20px_rgb(18_35_63/0.22)] ${
                feature ? "p-3 sm:p-6" : "p-1.5 sm:p-2.5"
              }`}
            />
          </span>
        </>
      ) : (
        <span aria-hidden="true" className="grid-rule absolute inset-0 text-blue-300 opacity-40" />
      )}

      {/* The frosted label strip along the foot of the card. */}
      <span
        className={`absolute inset-x-1.5 bottom-1.5 flex items-center justify-between gap-2 rounded-[10px] border border-white/70 bg-paper/80 shadow-[var(--shadow-raise)] backdrop-blur-md ${
          feature
            ? "px-3 py-2 sm:inset-x-3 sm:bottom-3 sm:rounded-[12px] sm:px-4 sm:py-3"
            : "px-2 py-1 max-sm:inset-x-1 max-sm:bottom-1 max-sm:px-1.5 sm:inset-x-2 sm:bottom-2 sm:rounded-[12px] sm:px-3 sm:py-2"
        }`}
      >
        <span className="flex min-w-0 flex-col">
          <span
            className={`line-clamp-2 font-display leading-tight text-ink hyphens-auto sm:line-clamp-1 ${
              feature ? "text-[0.8125rem] sm:text-h3" : "text-[0.6875rem] max-sm:text-[0.625rem] sm:text-[0.875rem]"
            }`}
          >
            {category.name}
          </span>
          <span className={`truncate text-[0.625rem] text-ink/70 sm:block sm:text-[0.75rem] ${feature ? "" : "hidden"}`}>
            {count}
            {/* The feature card names a few sub-shelves where there is room. */}
            {feature && category.children.length > 0 ? (
              <span className="hidden sm:inline">
                {" · "}
                {category.children
                  .slice(0, 3)
                  .map((child) => child.name)
                  .join(", ")}
              </span>
            ) : null}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-transform duration-200 ease-[var(--ease-out-quint)] group-hover:translate-x-0.5 ${
            /* A small card on a phone has no room for the arrow beside its name. */
            feature ? "inline-flex size-7 sm:size-9" : "hidden size-7 sm:inline-flex"
          }`}
        >
          <IconArrowRight size={14} />
        </span>
      </span>
    </Link>
  );
}
