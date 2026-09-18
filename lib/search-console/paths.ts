import { inArray } from "drizzle-orm";
import { categories, productSlugRedirects, products } from "@/db/schema";
import type { Executor } from "@/lib/pkb/common";
import { siteUrl } from "@/lib/seo";

/**
 * Turning a Search Console address into a page of this shop.
 *
 * Search Console reports full addresses, including ones this shop no longer
 * serves. The resolution is deliberately conservative: a path becomes a
 * listing or a shelf only when a row actually says so, an old address resolves
 * through the redirect table that Stage 4 built, and anything else is kept
 * with no entity attached. Dropping the unrecognised rows would hide exactly
 * the problem worth seeing — Google sending people to a page that has moved.
 */

export type ResolvedPath = {
  path: string;
  productId: string | null;
  categoryId: string | null;
  /** How the path was matched, for the screens. */
  via: "listing" | "old_address" | "shelf" | "other";
};

/**
 * The path part of an address, with the query string and fragment removed and
 * a trailing slash normalised away. Search parameters are dropped on purpose:
 * `?utm_source=` variants of one page are one page.
 */
export function pathOf(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  let path: string;
  if (trimmed.startsWith("/")) {
    path = trimmed;
  } else {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }
  path = path.split("?")[0].split("#")[0];
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  return path || "/";
}

/** True when the address belongs to this shop's own origin. */
export function isOwnAddress(address: string): boolean {
  const trimmed = address.trim();
  if (trimmed.startsWith("/")) return true;
  try {
    return new URL(trimmed).origin === new URL(siteUrl()).origin;
  } catch {
    return false;
  }
}

function slugFrom(path: string, prefix: string): string | null {
  if (!path.startsWith(`${prefix}/`)) return null;
  const rest = path.slice(prefix.length + 1);
  if (!rest || rest.includes("/")) return null;
  return decodeURIComponent(rest);
}

/**
 * Resolves many paths at once — three indexed reads rather than one per row,
 * because a sync arrives with thousands of them.
 */
export async function resolvePaths(executor: Executor, paths: string[]): Promise<Map<string, ResolvedPath>> {
  const unique = [...new Set(paths)];
  const resolved = new Map<string, ResolvedPath>();
  const productSlugs = new Map<string, string[]>();
  const categorySlugs = new Map<string, string[]>();

  for (const path of unique) {
    resolved.set(path, { path, productId: null, categoryId: null, via: "other" });
    const productSlug = slugFrom(path, "/products");
    if (productSlug) {
      productSlugs.set(productSlug, [...(productSlugs.get(productSlug) ?? []), path]);
      continue;
    }
    const categorySlug = slugFrom(path, "/categories");
    if (categorySlug) {
      categorySlugs.set(categorySlug, [...(categorySlugs.get(categorySlug) ?? []), path]);
    }
  }

  if (productSlugs.size > 0) {
    const slugs = [...productSlugs.keys()];
    const listings: { id: string; slug: string }[] = await executor
      .select({ id: products.id, slug: products.slug })
      .from(products)
      .where(inArray(products.slug, slugs));
    const bySlug = new Map(listings.map((row) => [row.slug, row.id]));

    const missing = slugs.filter((slug) => !bySlug.has(slug));
    const redirects: { fromSlug: string; productId: string }[] =
      missing.length === 0
        ? []
        : await executor
            .select({ fromSlug: productSlugRedirects.fromSlug, productId: productSlugRedirects.productId })
            .from(productSlugRedirects)
            .where(inArray(productSlugRedirects.fromSlug, missing));
    const byOldSlug = new Map(redirects.map((row) => [row.fromSlug, row.productId]));

    for (const [slug, forPaths] of productSlugs) {
      const current = bySlug.get(slug);
      const old = current ? undefined : byOldSlug.get(slug);
      if (!current && !old) continue;
      for (const path of forPaths) {
        resolved.set(path, {
          path,
          productId: current ?? old ?? null,
          categoryId: null,
          via: current ? "listing" : "old_address",
        });
      }
    }
  }

  if (categorySlugs.size > 0) {
    const shelves: { id: string; slug: string }[] = await executor
      .select({ id: categories.id, slug: categories.slug })
      .from(categories)
      .where(inArray(categories.slug, [...categorySlugs.keys()]));
    for (const shelf of shelves) {
      for (const path of categorySlugs.get(shelf.slug) ?? []) {
        resolved.set(path, { path, productId: null, categoryId: shelf.id, via: "shelf" });
      }
    }
  }

  return resolved;
}
