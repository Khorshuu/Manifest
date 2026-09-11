"use client";

import { useEffect } from "react";
import {
  parseRecentlyViewed,
  pushRecentlyViewed,
  RECENTLY_VIEWED_COOKIE,
} from "@/lib/account/recently-viewed";

/**
 * Records a product view in the recently-viewed cookie. Renders nothing.
 * Ids only; the server resolves them through the public predicate on read.
 */
export function RecentlyViewedTracker({ productId }: { productId: string }) {
  useEffect(() => {
    const raw = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith(`${RECENTLY_VIEWED_COOKIE}=`))
      ?.slice(RECENTLY_VIEWED_COOKIE.length + 1);

    const next = pushRecentlyViewed(parseRecentlyViewed(raw), productId);
    document.cookie = `${RECENTLY_VIEWED_COOKIE}=${encodeURIComponent(
      next.join(","),
    )}; path=/; max-age=${60 * 60 * 24 * 90}; samesite=lax`;
  }, [productId]);

  return null;
}
