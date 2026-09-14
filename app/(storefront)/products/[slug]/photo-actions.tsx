"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IconChevronLeft, IconHeart, IconShare } from "@/components/icons";

/**
 * Back, share and save, floating on the photograph on a phone (D-047).
 *
 * The owner's reference puts these three where a thumb already is when it is
 * swiping through the pictures. The wishlist holds an option rather than a
 * product (D-031), so the heart saves whichever option is chosen — the
 * picker announces the choice — and asks for one when nothing is chosen yet.
 * From `lg` none of this renders: the desktop keeps its own buttons.
 */
export function PhotoActions({
  title,
  backHref,
  variantIds,
  savedVariantIds,
  signedIn,
  returnTo,
}: {
  title: string;
  /** Where Back goes when there is no page of ours to go back to. */
  backHref: string;
  variantIds: string[];
  savedVariantIds: string[];
  signedIn: boolean;
  returnTo: string;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(
    variantIds.length === 1 ? variantIds[0] : "",
  );
  const [saved, setSaved] = useState(() => new Set(savedVariantIds));
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const onVariant = (event: Event) => {
      const id = (event as CustomEvent<{ variantId?: string }>).detail?.variantId;
      if (id) setSelectedId(id);
    };
    window.addEventListener("product:variant-selected", onVariant);
    return () => window.removeEventListener("product:variant-selected", onVariant);
  }, []);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 2600);
    return () => window.clearTimeout(timer);
  }, [note]);

  const isSaved = selectedId ? saved.has(selectedId) : false;

  function goBack() {
    // Only back into our own shop; a shopper who arrived from a search engine
    // is taken to the shelf rather than out of the site.
    const fromHere =
      document.referrer !== "" &&
      new URL(document.referrer).origin === window.location.origin;
    if (fromHere && window.history.length > 1) router.back();
    else router.push(backHref);
  }

  async function share() {
    const url = `${window.location.origin}${window.location.pathname}`;
    if (navigator.share) {
      // A dismissed share sheet rejects; that is not an error to report.
      await navigator.share({ title, url }).catch(() => undefined);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setNote("Link copied");
    } catch {
      setNote("Could not copy the link");
    }
  }

  async function toggleSaved() {
    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (!selectedId) {
      setNote("Choose an option to save it");
      // The picker opens its option sheet in answer.
      window.dispatchEvent(new CustomEvent("product:need-option"));
      return;
    }

    setPending(true);
    const response = await fetch("/api/account/wishlist", {
      method: isSaved ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variantId: selectedId }),
    });
    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setNote(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setSaved((current) => {
      const next = new Set(current);
      if (isSaved) next.delete(selectedId);
      else next.add(selectedId);
      return next;
    });
    setNote(isSaved ? "Removed from your wishlist" : "Saved to your wishlist");
  }

  const circle =
    /* No disc behind the icon — the photograph shows through — and the icons
       are white (owner's requests). A soft dark shadow on the stroke keeps
       white readable on a pale studio shot; a press briefly shades the round
       target. */
    "pointer-events-auto inline-flex size-11 items-center justify-center rounded-full bg-transparent text-paper transition-[transform,background-color] duration-100 [filter:drop-shadow(0_1px_3px_rgb(10_21_38/0.7))_drop-shadow(0_0_1.5px_rgb(10_21_38/0.6))] active:scale-95 active:bg-ink/15 disabled:opacity-60";

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-3 lg:hidden">
      <button type="button" onClick={goBack} className={circle}>
        <IconChevronLeft size={26} strokeWidth={2} />
        <span className="sr-only">Back</span>
      </button>

      <div className="flex gap-2">
        <button type="button" onClick={share} className={circle}>
          <IconShare size={21} strokeWidth={1.9} />
          <span className="sr-only">Share {title}</span>
        </button>
        <button
          type="button"
          onClick={toggleSaved}
          disabled={pending}
          aria-pressed={isSaved}
          className={circle}
        >
          {/* Keyed so the heart stamps each time it changes. */}
          <IconHeart
            key={isSaved ? "saved" : "not-saved"}
            size={22}
            strokeWidth={1.9}
            className={isSaved ? "animate-stamp fill-stamp-red text-stamp-red" : ""}
          />
          <span className="sr-only">
            {isSaved ? "Saved to your wishlist" : "Save to wishlist"}
          </span>
        </button>
      </div>

      <p
        role="status"
        className={`absolute left-1/2 top-16 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink/85 px-3 py-1.5 text-meta font-medium text-paper shadow-[var(--shadow-raise)] ${
          note ? "animate-fade-in" : "sr-only"
        }`}
      >
        {note}
      </p>
    </div>
  );
}
