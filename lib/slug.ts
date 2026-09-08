/**
 * URL slugs. Kept deterministic and ASCII-only, because slugs appear in
 * canonical URLs and sitemaps and must not change when a title is re-saved
 * with different punctuation.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Appends a numeric suffix until the slug is unused. The caller supplies the
 * existence check so this stays free of database concerns.
 */
export async function uniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base) || "item";
  if (!(await exists(root))) return root;

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${root}-${suffix}`;
    if (!(await exists(candidate))) return candidate;
  }

  throw new Error(`Could not find an unused slug for "${base}".`);
}
