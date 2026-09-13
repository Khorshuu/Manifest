"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/button";
import type { Campaign, CampaignSettings } from "@/lib/homepage/campaigns";
import type { LinkOption } from "./link-options";

/**
 * Homepage settings, as staff edit them.
 *
 * One tab per slide, five in all. A slide is its hero photograph, its words
 * and destinations, and the four showcase tiles beneath it; every control here
 * writes through `/api/admin/homepage/campaigns` and is live on the next
 * request. Images are uploaded, never linked, so the homepage cannot be
 * pointed at an address off this site.
 */
export function HomepageEditor({
  initial,
  linkOptions,
}: {
  initial: CampaignSettings;
  linkOptions: LinkOption[];
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [slot, setSlot] = useState(0);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const listId = useId();

  async function call(key: string, request: () => Promise<Response>, success: string) {
    setPending(key);
    setStatus(null);
    const response = await request().catch(() => null);
    setPending(null);

    const body = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) {
      setStatus({ tone: "error", text: body.error ?? "Something went wrong. Try again." });
      return false;
    }
    if (body.campaigns) setSettings(body.campaigns as CampaignSettings);
    setStatus({ tone: "ok", text: success });
    router.refresh();
    return true;
  }

  const patch = (index: number, values: Record<string, unknown>, success = "Saved. The homepage is showing it now.") =>
    call(`save-${index}`, () =>
      fetch("/api/admin/homepage/campaigns", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "update", slot: index, patch: values }),
      }),
      success,
    );

  const move = (index: number, direction: "up" | "down") =>
    call(`move-${index}`, () =>
      fetch("/api/admin/homepage/campaigns", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "move", slot: index, direction }),
      }),
      "Order saved.",
    ).then((ok) => {
      if (ok) setSlot(direction === "up" ? index - 1 : index + 1);
    });

  const upload = (index: number, target: "hero" | "tile", file: File, tile?: number) => {
    const data = new FormData();
    data.set("slot", String(index));
    data.set("target", target);
    if (tile !== undefined) data.set("tile", String(tile));
    data.set("file", file);
    return call(`img-${target}-${tile ?? "h"}`, () =>
      fetch("/api/admin/homepage/campaigns/image", { method: "POST", body: data }),
      "Image uploaded.",
    );
  };

  const removeImage = (index: number, target: "hero" | "tile", tile?: number) =>
    call(`img-${target}-${tile ?? "h"}`, () =>
      fetch("/api/admin/homepage/campaigns/image", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: index, target, tile }),
      }),
      "Image removed.",
    );

  const slide = settings.slides[slot];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <datalist id={listId}>
        {linkOptions.map((option) => (
          <option key={option.href} value={option.href}>
            {option.label}
          </option>
        ))}
      </datalist>

      <div role="tablist" aria-label="Slides" className="flex flex-wrap gap-2">
        {settings.slides.map((entry, index) => {
          const live = entry.active && Boolean(entry.image);
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={slot === index}
              onClick={() => setSlot(index)}
              className={`flex min-h-10 items-center gap-2 rounded-control border px-3 text-meta font-semibold transition-colors ${
                slot === index
                  ? "border-blue-600 bg-blue-600 text-paper"
                  : "border-blue-300 bg-paper text-ink hover:border-blue-500"
              }`}
            >
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${live ? "bg-transit-green" : "bg-ink/25"}`}
              />
              Slide {index + 1}
              <span className="font-normal opacity-80">
                {entry.name ? `· ${entry.name}` : live ? "" : "· empty"}
              </span>
              <span className="sr-only">{live ? "(live)" : "(not shown)"}</span>
            </button>
          );
        })}
      </div>

      <p aria-live="polite" className="min-h-5 text-meta">
        {status ? (
          <span className={status.tone === "ok" ? "text-transit-green-text" : "text-stamp-red-text"}>
            {status.text}
          </span>
        ) : null}
      </p>

      <SlideEditor
        key={`${slide.id}-${slot}`}
        index={slot}
        slide={slide}
        listId={listId}
        pending={pending}
        onSave={(values) => patch(slot, values)}
        onToggle={(active) =>
          patch(slot, { active }, active ? "Slide is live on the homepage." : "Slide hidden from the homepage.")
        }
        onMove={(direction) => move(slot, direction)}
        onUpload={(target, file, tile) => upload(slot, target, file, tile)}
        onRemoveImage={(target, tile) => removeImage(slot, target, tile)}
      />
    </div>
  );
}

type Draft = Pick<
  Campaign,
  "name" | "focalX" | "focalY" | "heroUrl" | "newTab" | "title" | "text" | "ctaText" | "ctaUrl" | "contrast"
> & { showcase: { title: string; url: string; active: boolean }[] };

function toDraft(slide: Campaign): Draft {
  return {
    name: slide.name,
    focalX: slide.focalX,
    focalY: slide.focalY,
    heroUrl: slide.heroUrl,
    newTab: slide.newTab,
    title: slide.title,
    text: slide.text,
    ctaText: slide.ctaText,
    ctaUrl: slide.ctaUrl,
    contrast: slide.contrast,
    showcase: slide.showcase.map(({ title, url, active }) => ({ title, url, active })),
  };
}

const label = "text-meta font-semibold text-ink";
const input =
  "min-h-10 w-full rounded-control border border-blue-300 bg-paper px-3 text-meta text-ink";
const hint = "text-[0.75rem] leading-snug text-ink/70";

function SlideEditor({
  index,
  slide,
  listId,
  pending,
  onSave,
  onToggle,
  onMove,
  onUpload,
  onRemoveImage,
}: {
  index: number;
  slide: Campaign;
  listId: string;
  pending: string | null;
  onSave: (values: Draft) => Promise<boolean>;
  onToggle: (active: boolean) => Promise<boolean>;
  onMove: (direction: "up" | "down") => void;
  onUpload: (target: "hero" | "tile", file: File, tile?: number) => Promise<boolean>;
  onRemoveImage: (target: "hero" | "tile", tile?: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(slide));
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(slide));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setTile = (tile: number, values: Partial<Draft["showcase"][number]>) =>
    setDraft((current) => ({
      ...current,
      showcase: current.showcase.map((item, position) =>
        position === tile ? { ...item, ...values } : item,
      ),
    }));

  const live = slide.active && Boolean(slide.image);
  const busy = pending !== null;

  return (
    <div className="flex flex-col gap-4">
      {/* Status and order */}
      <section className="admin-card flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <label className="relative inline-flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              role="switch"
              checked={slide.active}
              disabled={busy}
              onChange={(event) => void onToggle(event.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="relative h-6 w-11 rounded-full bg-ink/20 transition-colors peer-checked:bg-transit-green peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-brass after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-paper after:shadow after:transition-transform peer-checked:after:translate-x-5"
            />
            <span className="text-meta font-semibold text-ink">
              {slide.active ? "Active" : "Inactive"}
            </span>
          </label>
          <span className="text-meta text-ink/70">
            {live
              ? "Showing on the homepage."
              : slide.image
                ? "Switch on to show it."
                : "Upload a hero photograph, then switch on."}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-meta text-ink/70">Position {index + 1} of 5</span>
          <Button type="button" size="sm" variant="secondary" disabled={busy || index === 0} onClick={() => onMove("up")}>
            Move earlier
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={busy || index === 4} onClick={() => onMove("down")}>
            Move later
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* Hero */}
        <section className="admin-card flex min-w-0 flex-col gap-4">
          <h2 className="admin-h2">Hero photograph</h2>

          <div className="relative aspect-[16/8] w-full overflow-hidden rounded-[var(--radius-media)] border border-blue-300 bg-ink-deep">
            {slide.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={slide.image.url}
                alt="Hero preview"
                className="size-full object-cover"
                style={{ objectPosition: `${draft.focalX}% ${draft.focalY}%` }}
              />
            ) : (
              <p className="flex size-full items-center justify-center px-4 text-center text-meta text-paper/80">
                No photograph yet. A slide without one never appears on the site.
              </p>
            )}
            {slide.image && (draft.title || draft.ctaText) ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/60 to-transparent p-4 text-paper">
                {draft.title ? <p className="text-[1.25rem] font-extrabold leading-tight">{draft.title}</p> : null}
                {draft.text ? <p className="mt-1 line-clamp-2 text-meta opacity-85">{draft.text}</p> : null}
                {draft.ctaText ? (
                  <span className="mt-2 inline-flex rounded-full bg-paper px-3 py-1 text-[0.75rem] font-bold text-ink">
                    {draft.ctaText}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <ImageControls
            id={`hero-${index}`}
            hasImage={Boolean(slide.image)}
            busy={pending === "img-hero-h"}
            disabled={busy}
            labelText={slide.image ? "Replace photograph" : "Upload photograph"}
            onUpload={(file) => onUpload("hero", file)}
            onRemove={() => onRemoveImage("hero")}
            note="JPEG, PNG, WebP or AVIF, up to 5MB. Wide (about 2:1) and at least 2000px across looks best."
          />

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className={`${label} mb-2`}>Focal point — what stays in frame on narrow screens</legend>
            {(
              [
                { key: "focalX" as const, text: "Across" },
                { key: "focalY" as const, text: "Down" },
              ]
            ).map((axis) => (
              <label key={axis.key} className="flex flex-col gap-1 text-meta text-ink">
                <span>
                  {axis.text} <span className="tabular-nums text-ink/70">{draft[axis.key]}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={draft[axis.key]}
                  onChange={(event) => set(axis.key, Number(event.target.value))}
                  className="w-full accent-[var(--color-blue-600)]"
                />
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend className={`${label} mb-2`}>Header over this photograph</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { value: "auto" as const, text: "Automatic" },
                  { value: "light" as const, text: "Light lettering" },
                  { value: "dark" as const, text: "Dark lettering" },
                ]
              ).map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  aria-pressed={draft.contrast === mode.value}
                  onClick={() => set("contrast", mode.value)}
                  className="admin-chip"
                >
                  {mode.text}
                </button>
              ))}
            </div>
            <p className={`${hint} mt-1.5`}>
              Automatic measures the photograph. Choose one yourself if the image is bright or dark exactly where the navigation sits.
            </p>
          </fieldset>
        </section>

        {/* Words and destinations */}
        <section className="admin-card flex min-w-0 flex-col gap-3">
          <h2 className="admin-h2">Words and links</h2>

          <TextInput id={`name-${index}`} text="Internal name" hint="Only staff see this, e.g. “Winter snacks”." value={draft.name} max={80} onChange={(value) => set("name", value)} />
          <TextInput id={`url-${index}`} text="Hero destination" hint="Where clicking the photograph goes: a path like /categories/audio, or a full https:// address. Leave empty for no link." value={draft.heroUrl} max={500} list={listId} onChange={(value) => set("heroUrl", value)} />
          <label className="flex items-center gap-2 text-meta text-ink">
            <input type="checkbox" checked={draft.newTab} onChange={(event) => set("newTab", event.target.checked)} className="size-4" />
            Open links to other websites in a new tab
          </label>
          <TextInput id={`title-${index}`} text="Headline (optional)" value={draft.title} max={90} onChange={(value) => set("title", value)} />
          <div className="flex flex-col gap-1">
            <label htmlFor={`text-${index}`} className={label}>Supporting text (optional)</label>
            <textarea
              id={`text-${index}`}
              value={draft.text}
              maxLength={220}
              rows={2}
              onChange={(event) => set("text", event.target.value)}
              className={`${input} py-2`}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput id={`cta-${index}`} text="Button text (optional)" value={draft.ctaText} max={30} onChange={(value) => set("ctaText", value)} />
            <TextInput id={`ctaurl-${index}`} text="Button destination" hint="Empty uses the hero destination." value={draft.ctaUrl} max={500} list={listId} onChange={(value) => set("ctaUrl", value)} />
          </div>
          <p className={hint}>Leave the headline, text and button empty for a clean photograph with nothing over it.</p>
        </section>
      </div>

      <SlidePreview slide={slide} draft={draft} />

      {/* Showcase */}
      <section className="admin-card flex flex-col gap-3">
        <div>
          <h2 className="admin-h2">Showcase tiles</h2>
          <p className={hint}>
            The four tiles under this hero. Each is its own image and title — nothing is pulled from products — and each can link anywhere.
          </p>
        </div>

        <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {slide.showcase.map((item, tile) => (
            <li key={tile} className="flex min-w-0 flex-col gap-2 rounded-card border border-blue-200 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-meta font-semibold text-ink">Tile {tile + 1}</span>
                <label className="flex items-center gap-1.5 text-[0.75rem] text-ink/75">
                  <input
                    type="checkbox"
                    checked={draft.showcase[tile].active}
                    onChange={(event) => setTile(tile, { active: event.target.checked })}
                    className="size-4"
                  />
                  Active
                </label>
              </div>
              <div className="aspect-[4/3] overflow-hidden rounded-control bg-blue-50">
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image.url} alt={`Tile ${tile + 1} preview`} className="size-full object-cover" />
                ) : (
                  <p className="flex size-full items-center justify-center p-2 text-center text-[0.75rem] text-ink/70">
                    No image — this tile is not shown.
                  </p>
                )}
              </div>
              <ImageControls
                id={`tile-${index}-${tile}`}
                compact
                hasImage={Boolean(item.image)}
                busy={pending === `img-tile-${tile}`}
                disabled={busy}
                labelText={item.image ? "Replace" : "Upload image"}
                onUpload={(file) => onUpload("tile", file, tile)}
                onRemove={() => onRemoveImage("tile", tile)}
              />
              <TextInput id={`t-title-${index}-${tile}`} text="Title" value={draft.showcase[tile].title} max={60} onChange={(value) => setTile(tile, { title: value })} />
              <TextInput id={`t-url-${index}-${tile}`} text="Destination" value={draft.showcase[tile].url} max={500} list={listId} onChange={(value) => setTile(tile, { url: value })} />
            </li>
          ))}
        </ol>
      </section>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-3 rounded-card border border-blue-300 bg-paper/95 px-4 py-2.5 shadow-[var(--shadow-float)] backdrop-blur">
        <span className="mr-auto text-meta text-ink/70">
          {dirty ? "Unsaved changes on this slide." : "Everything on this slide is saved."}
        </span>
        <Button type="button" variant="secondary" size="sm" disabled={!dirty || busy} onClick={() => setDraft(toDraft(slide))}>
          Discard
        </Button>
        <Button type="button" size="sm" disabled={!dirty || busy} onClick={() => void onSave(draft)}>
          {pending?.startsWith("save") ? "Saving…" : "Save slide"}
        </Button>
      </div>
    </div>
  );
}

type PreviewDevice = "desktop" | "tablet" | "phone";

/**
 * The slide as a shopper will see it, on the three shapes of screen.
 *
 * Built from the unsaved draft, so a headline or a focal point shows here the
 * moment it is typed. It is a drawing of the storefront's composition, not the
 * storefront itself: the frame is a size container and every measurement below
 * is a share of its width (`cqw`), which is the same arithmetic the homepage
 * does against the screen — a 16:9 frame and four tiles across its foot on a
 * phone, a wider frame on a tablet and a desktop. Tiles that are switched off
 * or have no image are left out, exactly as on the site.
 */
function SlidePreview({ slide, draft }: { slide: Campaign; draft: Draft }) {
  const [device, setDevice] = useState<PreviewDevice>("desktop");

  const frame: Record<PreviewDevice, { width: string; stage: string; tile: string; overlap: string; label: string }> = {
    desktop: { width: "w-full", stage: "h-[55cqw]", tile: "w-[16.25%]", overlap: "-mt-[11.9cqw]", label: "Desktop" },
    tablet: { width: "w-full max-w-[520px]", stage: "h-[62cqw]", tile: "w-[18.4%]", overlap: "-mt-[13.4cqw]", label: "Tablet" },
    phone: { width: "w-full max-w-[300px]", stage: "h-[56.25cqw]", tile: "w-[22.5%]", overlap: "-mt-[16cqw]", label: "Phone" },
  };
  const shape = frame[device];

  const tiles = slide.showcase
    .map((item, position) => ({ item, draft: draft.showcase[position] }))
    .filter(({ item, draft: tile }) => tile.active && item.image);

  return (
    <section className="admin-card flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="admin-h2">Preview</h2>
        <div role="group" aria-label="Preview size" className="flex gap-1.5">
          {(Object.keys(frame) as PreviewDevice[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={device === option}
              onClick={() => setDevice(option)}
              className="admin-chip"
            >
              {frame[option].label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-center rounded-card bg-blue-50 p-3">
        <div className={`${shape.width} @container overflow-hidden rounded-[10px] border border-blue-200 bg-[#f5f6f8]`}>
          <div className={`relative ${shape.stage} overflow-hidden bg-ink-deep`}>
            {slide.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={slide.image.url}
                alt=""
                className="absolute inset-0 size-full object-cover"
                style={{ objectPosition: `${draft.focalX}% ${draft.focalY}%` }}
              />
            ) : (
              <p className="flex size-full items-center justify-center px-4 text-center text-[0.75rem] text-paper/80">
                No photograph — this slide is not shown.
              </p>
            )}
            {slide.image && (draft.title || draft.text || draft.ctaText) ? (
              <div className="absolute inset-x-0 bottom-0 flex flex-col items-center px-[8cqw] pb-[calc(12cqw+3cqw)] text-center text-paper [text-shadow:0_1px_12px_rgb(10_21_38/0.4)]">
                {draft.title ? (
                  <p className="line-clamp-2 text-[4.4cqw] font-extrabold leading-[1.05]">{draft.title}</p>
                ) : null}
                {draft.text ? (
                  <p className="mt-[0.8cqw] line-clamp-1 text-[1.8cqw] opacity-85">{draft.text}</p>
                ) : null}
                {draft.ctaText ? (
                  <span className="mt-[1.4cqw] rounded-full bg-paper px-[2.2cqw] py-[0.8cqw] text-[1.6cqw] font-bold text-ink [text-shadow:none]">
                    {draft.ctaText}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {tiles.length > 0 ? (
            <ul className={`relative ${shape.overlap} flex justify-center gap-[1.6cqw] px-[4cqw] pb-[4cqw]`}>
              {tiles.map(({ item, draft: tile }, position) => (
                <li key={position} className={`${shape.tile} shrink-0 rounded-[2cqw] bg-paper p-[0.6cqw] shadow-[0_1px_2px_rgb(18_35_63/0.06),0_6px_16px_-6px_rgb(18_35_63/0.18)]`}>
                  <span className="flex aspect-square items-center justify-center overflow-hidden rounded-[1.6cqw] bg-[#eceef1]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.image!.url} alt="" className="size-full object-contain p-[3%]" />
                  </span>
                  {tile.title ? (
                    <span className="block truncate px-[0.4cqw] pt-[0.8cqw] text-center text-[1.5cqw] font-bold text-ink">
                      {tile.title}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="h-[4cqw]" />
          )}
        </div>
      </div>
      <p className="text-[0.75rem] text-ink/70">
        Unsaved changes show here straight away. Tiles that are off or have no image are left out, as on the site.
      </p>
    </section>
  );
}

function TextInput({
  id,
  text,
  hint: hintText,
  value,
  max,
  list,
  onChange,
}: {
  id: string;
  text: string;
  hint?: string;
  value: string;
  max: number;
  list?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={label}>{text}</label>
      <input
        id={id}
        value={value}
        maxLength={max}
        list={list}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hintText ? `${id}-hint` : undefined}
        className={input}
      />
      {hintText ? <p id={`${id}-hint`} className={hint}>{hintText}</p> : null}
    </div>
  );
}

function ImageControls({
  id,
  hasImage,
  busy,
  disabled,
  labelText,
  onUpload,
  onRemove,
  note,
  compact = false,
}: {
  id: string;
  hasImage: boolean;
  busy: boolean;
  disabled: boolean;
  labelText: string;
  onUpload: (file: File) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  note?: string;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={id}
          className={`inline-flex cursor-pointer items-center justify-center rounded-control border border-blue-300 bg-paper font-semibold text-blue-600 transition-colors hover:border-blue-500 hover:bg-blue-50 ${
            compact ? "min-h-8 px-2.5 text-[0.75rem]" : "min-h-9 px-3 text-meta"
          } ${disabled ? "pointer-events-none opacity-60" : ""}`}
        >
          {busy ? "Working…" : labelText}
        </label>
        <input
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void onUpload(file);
          }}
        />
        {hasImage ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onRemove()}
            className={`rounded-control font-semibold text-stamp-red-text hover:bg-stamp-red/5 disabled:opacity-50 ${
              compact ? "min-h-8 px-2 text-[0.75rem]" : "min-h-9 px-2.5 text-meta"
            }`}
          >
            Remove
          </button>
        ) : null}
      </div>
      {note ? <p className={hint}>{note}</p> : null}
    </div>
  );
}
