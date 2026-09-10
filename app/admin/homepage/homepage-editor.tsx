"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/button";
import type { HeroSettings } from "@/lib/homepage";

export type ShowcaseCandidate = {
  slug: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  priceLabel: string;
};

/**
 * The homepage, as staff edit it.
 *
 * Two things live here, and both are real: the photograph that fills the first
 * screen, and the four products directly beneath it. Every control writes
 * through `/api/admin/homepage/*` to `site_settings` and shows on the
 * storefront on the next request — there is no preview-only mode and no
 * setting on this page that does nothing.
 *
 * There are no words to edit any more. The hero used to carry a headline, a
 * paragraph, a price panel and a button; the owner asked for the image to be
 * unobstructed, so those controls were removed rather than left on a page
 * where they would change nothing.
 */
export function HomepageEditor({
  hero: initialHero,
  showcase: initialShowcase,
  products,
}: {
  hero: HeroSettings;
  /** The chosen row, in order, already resolved to real products. */
  showcase: ShowcaseCandidate[];
  /** Everything public, for the "add" control. */
  products: ShowcaseCandidate[];
}) {
  const router = useRouter();
  const [hero, setHero] = useState(initialHero);
  /*
   * The row is not local state. Every change to it goes to the server and the
   * server component re-resolves the slugs to products, so keeping a second
   * copy here would only create something to disagree with.
   */
  const showcase = initialShowcase;
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function send(
    section: string,
    request: () => Promise<Response>,
  ): Promise<boolean> {
    setPending(section);
    setError(null);
    setSaved(null);

    const response = await request();
    setPending(null);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return false;
    }

    const body = await response.json();
    if (body.hero) setHero(body.hero as HeroSettings);
    setSaved(section);
    // The row comes back as slugs; the server component re-resolves them to
    // products, which is why this refreshes rather than patching local state.
    router.refresh();
    return true;
  }

  const patchHero = (section: string, values: Partial<HeroSettings>) =>
    send(section, () =>
      fetch("/api/admin/homepage/hero", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      }),
    );

  const patchShowcase = (section: string, body: Record<string, unknown>) =>
    send(section, () =>
      fetch("/api/admin/homepage/showcase", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    const ok = await send("image", () =>
      fetch("/api/admin/homepage/hero", { method: "POST", body: data }),
    );

    if (ok) form.reset();
  }

  const inShowcase = new Set(showcase.map((entry) => entry.slug));
  const addable = products.filter((product) => !inShowcase.has(product.slug));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p aria-live="polite" className="text-meta">
        {error ? (
          <span className="text-stamp-red-text">{error}</span>
        ) : saved ? (
          <span className="text-transit-green-text">
            Saved. The homepage is showing it now.
          </span>
        ) : null}
      </p>

      <section className="flex flex-col gap-4 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)]">
        <div>
          <h2 className="font-display text-h2 text-ink">Hero photograph</h2>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            One image, shown edge to edge across the first screen with nothing
            written on top of it. JPEG, PNG, WebP or AVIF, up to 5MB. A wide,
            evenly lit photograph works best — only the header sits over it.
            With no photograph, the first product of the row below stands in.
          </p>
        </div>

        {/*
         * The preview is the storefront's own shape — wide, cropped, with the
         * focal point applied. A square thumbnail would hide exactly the thing
         * being decided here.
         */}
        <div className="relative aspect-[21/9] w-full overflow-hidden rounded-[var(--radius-media)] border border-blue-300 bg-ink-deep">
          {hero.imageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={hero.imageUrl}
              alt="The current homepage hero"
              className="size-full object-cover"
              style={{ objectPosition: `${hero.focalX}% ${hero.focalY}%` }}
            />
          ) : (
            <p className="flex size-full items-center justify-center px-4 text-center text-meta text-paper/80">
              No photograph yet — the first product of the row below is standing
              in.
            </p>
          )}
        </div>

        <form onSubmit={upload} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label
              htmlFor="hero-image"
              className="text-meta font-semibold text-ink"
            >
              {hero.imageUrl ? "Replace the photograph" : "Upload a photograph"}
            </label>
            <input
              id="hero-image"
              name="file"
              type="file"
              required
              accept="image/jpeg,image/png,image/webp,image/avif"
              className="min-h-11 w-full max-w-md rounded-control border border-blue-300 bg-paper px-3 py-2 text-meta text-ink"
            />
          </div>

          <Button type="submit" disabled={pending === "image"}>
            {pending === "image" ? "Uploading…" : "Upload"}
          </Button>

          {hero.imageUrl ? (
            <Button
              type="button"
              variant="danger"
              disabled={pending === "remove"}
              onClick={() =>
                send("remove", () =>
                  fetch("/api/admin/homepage/hero", { method: "DELETE" }),
                )
              }
            >
              {pending === "remove" ? "Removing…" : "Remove"}
            </Button>
          ) : null}
        </form>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-meta font-semibold text-ink">
            Focal point
          </legend>
          <p className="max-w-[70ch] text-meta text-ink/70">
            What stays in frame when the screen is narrower than the
            photograph. 50 / 50 is the middle. Drag, then save.
          </p>

          <div className="flex flex-wrap gap-5">
            {(
              [
                { key: "focalX" as const, label: "Across" },
                { key: "focalY" as const, label: "Down" },
              ]
            ).map((axis) => (
              <label
                key={axis.key}
                className="flex min-w-[14rem] flex-1 flex-col gap-1 text-meta text-ink"
              >
                <span className="font-medium">
                  {axis.label}
                  <span className="ml-2 tabular-nums text-ink/70">
                    {hero[axis.key]}%
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={hero[axis.key]}
                  onChange={(event) =>
                    setHero((current) => ({
                      ...current,
                      [axis.key]: Number(event.target.value),
                    }))
                  }
                  className="w-full accent-[var(--color-blue-600)]"
                />
              </label>
            ))}
          </div>

          <div>
            <Button
              type="button"
              variant="secondary"
              disabled={pending === "focal"}
              onClick={() =>
                patchHero("focal", { focalX: hero.focalX, focalY: hero.focalY })
              }
            >
              {pending === "focal" ? "Saving…" : "Save focal point"}
            </Button>
          </div>
        </fieldset>
      </section>

      <section className="flex flex-col gap-4 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)]">
        <div>
          <h2 className="font-display text-h2 text-ink">Header contrast</h2>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            The header is drawn straight over the photograph. On{" "}
            <strong>Automatic</strong> the browser measures the image and takes
            the opposite treatment. Choose one yourself when a photograph is
            dark overall but bright exactly where the navigation sits.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: "auto" as const, label: "Automatic" },
              { value: "light" as const, label: "Light lettering" },
              { value: "dark" as const, label: "Dark lettering" },
            ]
          ).map((mode) => (
            <button
              key={mode.value}
              type="button"
              disabled={pending === "contrast"}
              aria-pressed={hero.contrast === mode.value}
              onClick={() => patchHero("contrast", { contrast: mode.value })}
              className={`min-h-11 rounded-control border px-4 text-meta font-semibold transition-colors ${
                hero.contrast === mode.value
                  ? "border-blue-600 bg-blue-50 text-blue-600"
                  : "border-blue-300 bg-paper text-ink/70 hover:border-blue-500"
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)]">
        <div>
          <h2 className="font-display text-h2 text-ink">
            The four products under the hero
          </h2>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            Chosen and ordered here; the first four are what a wide screen
            shows. Each card takes the product&rsquo;s own main photograph, so
            changing the picture is done on the product — use{" "}
            <strong>Make main</strong> in its Photographs section. With nothing
            chosen, the homepage shows whatever closes soonest.
          </p>
        </div>

        {showcase.length === 0 ? (
          <p className="rounded-control border border-blue-300 bg-blue-50 p-4 text-meta text-ink">
            Nothing chosen. The homepage is picking the four batches closing
            soonest, which is a reasonable default — add products below to take
            it over.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {showcase.map((entry, index) => (
              <li
                key={entry.slug}
                className="flex flex-wrap items-center gap-3 rounded-card border border-blue-300 p-3"
              >
                <span className="surface-studio flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-control">
                  {entry.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={entry.imageUrl}
                      alt=""
                      width={64}
                      height={64}
                      className="size-full object-cover"
                    />
                  ) : (
                    <span className="text-meta text-ink/70">No photo</span>
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block text-meta text-ink/70">
                    {index + 1}
                    {entry.brand ? ` · ${entry.brand}` : ""}
                  </span>
                  <Link
                    href={`/admin/products?q=${encodeURIComponent(entry.title)}`}
                    className="block truncate font-display text-h3 text-ink hover:text-blue-600"
                  >
                    {entry.title}
                  </Link>
                  <span className="block text-meta tabular-nums text-ink/70">
                    {entry.priceLabel}
                  </span>
                </span>

                <span className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={pending !== null || index === 0}
                    onClick={() =>
                      patchShowcase("row", {
                        action: "move",
                        slug: entry.slug,
                        direction: "up",
                      })
                    }
                    className="min-h-11 rounded-control border border-blue-300 px-3 text-meta text-blue-600 disabled:opacity-40"
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    disabled={pending !== null || index === showcase.length - 1}
                    onClick={() =>
                      patchShowcase("row", {
                        action: "move",
                        slug: entry.slug,
                        direction: "down",
                      })
                    }
                    className="min-h-11 rounded-control border border-blue-300 px-3 text-meta text-blue-600 disabled:opacity-40"
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() =>
                      patchShowcase("row", {
                        action: "remove",
                        slug: entry.slug,
                      })
                    }
                    className="min-h-11 rounded-control border border-blue-300 px-3 text-meta text-stamp-red-text disabled:opacity-40"
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}

        <form
          className="flex flex-wrap items-end gap-3 border-t border-blue-300 pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            const slug = String(
              new FormData(event.currentTarget).get("slug") ?? "",
            );
            if (slug) patchShowcase("row", { action: "add", slug });
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor="add-slug" className="text-meta font-semibold text-ink">
              Add a product
            </label>
            <select
              id="add-slug"
              name="slug"
              required
              className="min-h-11 w-full max-w-md rounded-control border border-blue-300 bg-paper px-3 text-body"
            >
              <option value="">Choose a product…</option>
              {addable.map((product) => (
                <option key={product.slug} value={product.slug}>
                  {product.brand ? `${product.brand} — ` : ""}
                  {product.title}
                </option>
              ))}
            </select>
          </div>

          <Button type="submit" variant="secondary" disabled={pending !== null}>
            Add to the row
          </Button>
        </form>

        <p className="text-meta text-ink/70">
          A product can also be added from its own page in the admin, which is
          usually where you are when you decide.
        </p>
      </section>
    </div>
  );
}
