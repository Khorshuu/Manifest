"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass } from "./button";
import { IconHeart } from "./icons";

/**
 * Save the chosen option to the wishlist, or take it off again.
 *
 * A guest is sent to sign in and brought back, rather than shown a button that
 * then fails — the list lives on the account.
 */
export function WishlistButton({
  variantId,
  initiallySaved,
  signedIn,
  returnTo,
}: {
  variantId: string;
  initiallySaved: boolean;
  signedIn: boolean;
  returnTo: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initiallySaved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <a
        href={`/login?next=${encodeURIComponent(returnTo)}`}
        className={buttonClass({ variant: "quiet", size: "sm", className: "self-start" })}
      >
        <IconHeart size={16} />
        Sign in to save to your wishlist
      </a>
    );
  }

  async function toggle() {
    setPending(true);
    setError(null);
    const response = await fetch("/api/account/wishlist", {
      method: saved ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variantId }),
    });
    const body = await response.json().catch(() => ({}));
    setPending(false);

    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }
    setSaved(!saved);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={saved}
        className={buttonClass({ variant: "quiet", size: "sm", className: "self-start" })}
      >
        {/* The heart the header uses for the wishlist, filled once saved —
            and keyed so it stamps as the state changes. */}
        <IconHeart
          key={saved ? "saved" : "not-saved"}
          size={16}
          className={saved ? "animate-stamp fill-stamp-red text-stamp-red" : ""}
        />
        {saved ? "Saved to your wishlist" : "Save to wishlist"}
      </button>
      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>
    </div>
  );
}
