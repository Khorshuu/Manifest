import Link from "next/link";
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
 * The category board.
 *
 * Deliberately not a row of equal tiles: the first category gets the large
 * cell, so the grid has somewhere for the eye to land before it starts
 * scanning. Each tile carries a real photograph of something filed in that
 * category, which is what makes a shelf read as a shelf.
 *
 * The count is a real query. An empty category says "nothing open yet" rather
 * than being hidden, because a shopper looking for it should find out it
 * exists and is quiet, not be left wondering.
 */
export function CategoryBento({
  categories,
}: {
  categories: BentoCategory[];
}) {
  if (categories.length === 0) return null;

  const [lead, ...rest] = categories;

  return (
    <section className="mx-auto w-full max-w-[1280px] px-4 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
            <span aria-hidden="true" className="h-px w-8 bg-brass" />
            The shelves
          </p>
          <h2 className="mt-2 font-display text-h1 text-ink">Browse by kind</h2>
        </div>
        <Link
          href="/search"
          className="text-meta text-blue-600 underline-offset-4 hover:underline"
        >
          Everything at once
        </Link>
      </div>

      <Stagger className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StaggerItem className="sm:col-span-2 sm:row-span-2">
          <BentoTile category={lead} lead />
        </StaggerItem>

        {rest.map((category) => (
          <StaggerItem key={category.id} className="h-full">
            <BentoTile category={category} />
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

function BentoTile({
  category,
  lead = false,
}: {
  category: BentoCategory;
  lead?: boolean;
}) {
  const subtitle =
    category.children.length > 0
      ? category.children.map((child) => child.name).join(" · ")
      : category.productCount === 1
        ? "1 listing"
        : `${category.productCount} listings`;

  return (
    <Link
      href={`/categories/${category.slug}`}
      className={`media-zoom lift group relative flex flex-col justify-end overflow-hidden rounded-card border border-blue-300 bg-ink shadow-[var(--shadow-raise)] ${
        lead ? "h-full min-h-[280px]" : "h-full min-h-[150px]"
      }`}
    >
      {category.imageUrl ? (
        /* Local seed media; next/image once the storage integration lands. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={category.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid-rule absolute inset-0 text-paper opacity-15"
        />
      )}

      {/* A wash rather than a flat scrim: the goods stay visible at the top of
          the tile and the words stay readable at the bottom. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-ink from-[8%] via-ink/60 via-[48%] to-ink/5"
      />

      <span className="relative flex flex-col gap-1 p-4">
        <span
          className={`font-display text-paper ${lead ? "text-h1" : "text-h3"}`}
        >
          {category.name}
        </span>
        <span className="text-meta text-paper/75">{subtitle}</span>

        <span className="mt-2 inline-flex items-center gap-2 text-meta font-medium text-brass">
          Open the shelf
          <IconArrowRight
            size={16}
            className="transition-transform duration-200 ease-[var(--ease-out-quint)] group-hover:translate-x-1"
          />
        </span>
      </span>
    </Link>
  );
}
