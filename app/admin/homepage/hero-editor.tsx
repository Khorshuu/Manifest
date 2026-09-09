"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/button";
import type { HeroSettings } from "@/lib/homepage";

type FeaturableProduct = { slug: string; title: string; brand: string | null };

/**
 * The hero editor.
 *
 * Three things it deliberately does. It saves each section on its own, so a
 * rejected headline cannot discard an unrelated edit. It previews the
 * photograph at the shape the storefront actually draws it, including the
 * focal point, because a focal point chosen against a square thumbnail is
 * chosen blind. And it never keeps its own copy of the hero: every save
 * returns the stored record and that is what the form then shows.
 */
export function HeroEditor({
  hero: initial,
  products,
}: {
  hero: HeroSettings;
  products: FeaturableProduct[];
}) {
  const router = useRouter();
  const [hero, setHero] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    // The storefront is a separate route; refreshing keeps this page's own
    // server data (the product list) in step too.
    router.refresh();
    return true;
  }

  const patch = (section: string, values: Partial<HeroSettings>) =>
    send(section, () =>
      fetch("/api/admin/homepage/hero", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
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
          <h2 className="font-display text-h2 text-ink">Photograph</h2>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            One image, shown edge to edge across the first screen. JPEG, PNG,
            WebP or AVIF, up to 5MB. A wide, evenly lit photograph works best —
            the header sits on top of it. With no photograph, the hero falls
            back to the featured product&rsquo;s own artwork.
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
              No photograph yet — the featured product&rsquo;s artwork is
              standing in.
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
              ref={fileRef}
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
                patch("focal", { focalX: hero.focalX, focalY: hero.focalY })
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
              onClick={() => patch("contrast", { contrast: mode.value })}
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
          <h2 className="font-display text-h2 text-ink">Words and the batch</h2>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            The price, availability, capacity and closing time under the
            headline are read from the product itself — they are never typed
            here, so the hero cannot state a price the listing disagrees with.
          </p>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            patch("words", {
              eyebrow: String(data.get("eyebrow") ?? ""),
              headline: String(data.get("headline") ?? ""),
              support: String(data.get("support") ?? ""),
              ctaLabel: String(data.get("ctaLabel") ?? ""),
              ctaHref: String(data.get("ctaHref") ?? ""),
              featuredSlug: String(data.get("featuredSlug") ?? "") || null,
            });
          }}
        >
          <label className="flex flex-col gap-1 text-meta text-ink">
            <span className="font-semibold">Eyebrow</span>
            <input
              name="eyebrow"
              defaultValue={hero.eyebrow}
              maxLength={80}
              className="min-h-11 w-full rounded-control border border-blue-300 bg-paper px-3 text-body"
            />
            <span className="text-ink/70">
              Leave empty and the hero states the batch&rsquo;s real position —
              closing shortly, full, or open.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-meta text-ink">
            <span className="font-semibold">Headline</span>
            <input
              name="headline"
              required
              defaultValue={hero.headline}
              maxLength={120}
              className="min-h-11 w-full rounded-control border border-blue-300 bg-paper px-3 text-body"
            />
            <span className="text-ink/70">
              The page&rsquo;s only h1. Short lines read best — it is set very
              large.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-meta text-ink">
            <span className="font-semibold">Supporting sentence</span>
            <textarea
              name="support"
              rows={3}
              defaultValue={hero.support}
              maxLength={280}
              className="w-full rounded-control border border-blue-300 bg-paper p-3 text-body"
            />
          </label>

          <div className="flex flex-wrap gap-4">
            <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-meta text-ink">
              <span className="font-semibold">Button</span>
              <input
                name="ctaLabel"
                required
                defaultValue={hero.ctaLabel}
                maxLength={40}
                className="min-h-11 w-full rounded-control border border-blue-300 bg-paper px-3 text-body"
              />
            </label>

            <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-meta text-ink">
              <span className="font-semibold">Button goes to</span>
              <input
                name="ctaHref"
                defaultValue={hero.ctaHref}
                maxLength={200}
                placeholder="/search?preorder=1"
                className="min-h-11 w-full rounded-control border border-blue-300 bg-paper px-3 text-body"
              />
              <span className="text-ink/70">
                A path on this site. Empty means the featured
                product&rsquo;s own page.
              </span>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-meta text-ink">
            <span className="font-semibold">Featured product</span>
            <select
              name="featuredSlug"
              defaultValue={hero.featuredSlug ?? ""}
              className="min-h-11 w-full max-w-md rounded-control border border-blue-300 bg-paper px-3 text-body"
            >
              <option value="">Whichever batch closes soonest</option>
              {products.map((product) => (
                <option key={product.slug} value={product.slug}>
                  {product.brand ? `${product.brand} — ` : ""}
                  {product.title}
                </option>
              ))}
            </select>
            <span className="text-ink/70">
              If the product you choose is later unpublished, the hero falls
              back to the soonest-closing batch rather than showing nothing.
            </span>
          </label>

          <div>
            <Button type="submit" disabled={pending === "words"}>
              {pending === "words" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
