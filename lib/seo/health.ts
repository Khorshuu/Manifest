import { sql } from "drizzle-orm";
import { db } from "@/db";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { queryRows, type Executor } from "@/lib/pkb/common";

/**
 * The SEO Health Center (D-081).
 *
 * Every figure on this screen is a count from a query over real listings. There
 * is no site score, no grade and no prediction: the screen says how many
 * published listings have no meta description, how many share a title with
 * another, how many photographs have no description, how many rich results
 * would carry an identifier — facts a person can act on, one listing at a time.
 *
 * Nothing here writes. The fixes are the ordinary editor and, for facts, the
 * knowledge base's review screens.
 */

export type HealthIssue = {
  id: string;
  label: string;
  /** What the count means, and why it matters. */
  explanation: string;
  severity: "required" | "recommended" | "optional";
  count: number;
  /** Listings to start with, newest first. */
  examples: { id: string; title: string; slug: string; detail: string | null }[];
};

export type SeoHealth = {
  publishedListings: number;
  indexableListings: number;
  issues: HealthIssue[];
  /** Listings with nothing wrong, by these checks. */
  clean: number;
  structuredData: {
    withIdentifier: number;
    withBrand: number;
    withOffer: number;
    withImage: number;
  };
  redirects: number;
  lockedFields: number;
};

const EXAMPLE_LIMIT = 5;

type Row = { id: string; title: string; slug: string; detail: string | null };

/**
 * One check: a WHERE clause over published, indexable listings, its count and a
 * few examples. Written as one query per check on purpose — the SQL beside the
 * explanation is what makes each number checkable by hand.
 */
async function issue(
  executor: Executor,
  statuses: string,
  input: { id: string; label: string; explanation: string; severity: HealthIssue["severity"]; where: ReturnType<typeof sql>; detail?: ReturnType<typeof sql> },
): Promise<HealthIssue> {
  const rows = await queryRows<Row & { total: number }>(
    executor,
    sql`
      with matching as (
        select p.id, p.title, p.slug, p.updated_at,
               ${input.detail ?? sql`null::text`} as detail
        from products p
        where p.archived_at is null
          and p.status = any(${statuses}::text[])
          and p.seo_no_index = false
          and (${input.where})
      )
      select id, title, slug, detail, (select count(*)::int from matching) as total
      from matching
      order by updated_at desc
      limit ${EXAMPLE_LIMIT}
    `,
  );
  return {
    id: input.id,
    label: input.label,
    explanation: input.explanation,
    severity: input.severity,
    count: rows[0]?.total ?? 0,
    examples: rows.map((row) => ({ id: row.id, title: row.title, slug: row.slug, detail: row.detail })),
  };
}

export async function seoHealth(actor: SessionUser | null, executor: Executor = db): Promise<SeoHealth> {
  requirePermission(actor, "catalog.manage");
  const statuses = `{${PUBLIC_STATUSES.join(",")}}`;

  const [counts] = await queryRows<{
    published: number;
    indexable: number;
    with_identifier: number;
    with_brand: number;
    with_offer: number;
    with_image: number;
    redirects: number;
    locked_fields: number;
  }>(
    executor,
    sql`
      select
        count(*) filter (where p.archived_at is null and p.status = any(${statuses}::text[]))::int as published,
        count(*) filter (where p.archived_at is null and p.status = any(${statuses}::text[]) and p.seo_no_index = false)::int as indexable,
        count(*) filter (
          where p.archived_at is null and p.status = any(${statuses}::text[]) and p.seo_no_index = false
            and exists (
              select 1 from pkb_identifiers i
              where i.pkb_product_id = p.pkb_product_id
                and i.validation_status = 'valid'
                and i.verification_state in ('VERIFIED', 'MANUAL')
            )
        )::int as with_identifier,
        count(*) filter (
          where p.archived_at is null and p.status = any(${statuses}::text[]) and p.seo_no_index = false
            and exists (
              select 1 from pkb_facts f
              join pkb_attribute_definitions d on d.id = f.definition_id
              where f.pkb_product_id = p.pkb_product_id and d.key = 'brand'
                and f.pkb_variant_id is null
                and f.verification_state in ('VERIFIED', 'MANUAL')
            )
        )::int as with_brand,
        count(*) filter (
          where p.archived_at is null and p.status = any(${statuses}::text[]) and p.seo_no_index = false
            and exists (
              select 1 from product_variants v
              where v.product_id = p.id and v.archived_at is null and v.is_enabled
            )
        )::int as with_offer,
        count(*) filter (
          where p.archived_at is null and p.status = any(${statuses}::text[]) and p.seo_no_index = false
            and exists (select 1 from product_images i where i.product_id = p.id and i.kind = 'gallery')
        )::int as with_image,
        (select count(*)::int from product_slug_redirects) as redirects,
        (select count(*)::int from seo_field_states where state = 'LOCKED') as locked_fields
      from products p
    `,
  );

  const issues = await Promise.all([
    issue(executor, statuses, {
      id: "missing_meta_title",
      label: "No SEO title",
      explanation:
        "The search result falls back to the product name, which is often longer than the space and cut mid-word.",
      severity: "recommended",
      where: sql`p.seo_meta_title is null or btrim(p.seo_meta_title) = ''`,
    }),
    issue(executor, statuses, {
      id: "missing_meta_description",
      label: "No meta description",
      explanation: "Search engines write their own snippet from the page, which rarely says what you would say.",
      severity: "recommended",
      where: sql`p.seo_meta_description is null or btrim(p.seo_meta_description) = ''`,
    }),
    issue(executor, statuses, {
      id: "duplicate_meta_title",
      label: "SEO title shared with another listing",
      explanation:
        "Two pages competing on the same title makes them compete with each other. Give each one the words that separate it.",
      severity: "recommended",
      where: sql`p.seo_meta_title is not null and btrim(p.seo_meta_title) <> '' and exists (
        select 1 from products other
        where other.id <> p.id and other.archived_at is null
          and other.status = any(${statuses}::text[])
          and lower(btrim(other.seo_meta_title)) = lower(btrim(p.seo_meta_title))
      )`,
      detail: sql`p.seo_meta_title`,
    }),
    issue(executor, statuses, {
      id: "long_meta_title",
      label: "SEO title longer than 60 characters",
      explanation: "Anything past roughly 60 characters is cut off in the result.",
      severity: "optional",
      where: sql`char_length(btrim(coalesce(p.seo_meta_title, ''))) > 60`,
      detail: sql`char_length(btrim(p.seo_meta_title)) || ' characters'`,
    }),
    issue(executor, statuses, {
      id: "thin_description",
      label: "Description under 300 characters",
      explanation: "A page with little to read answers fewer questions, and has less to be found by.",
      severity: "required",
      where: sql`char_length(regexp_replace(coalesce(p.description_html, ''), '<[^>]*>', ' ', 'g')) < 300`,
      detail: sql`char_length(regexp_replace(coalesce(p.description_html, ''), '<[^>]*>', ' ', 'g')) || ' characters'`,
    }),
    issue(executor, statuses, {
      id: "no_gallery_image",
      label: "No product photograph",
      explanation: "A product result without an image is rarely shown at all.",
      severity: "required",
      where: sql`not exists (select 1 from product_images i where i.product_id = p.id and i.kind = 'gallery')`,
    }),
    issue(executor, statuses, {
      id: "thin_image_alt",
      label: "Photographs without a description",
      explanation:
        "Alt text is what image search and a screen reader read. A filename or the word \"image\" describes nothing.",
      severity: "recommended",
      where: sql`exists (
        select 1 from product_images i
        where i.product_id = p.id
          and (char_length(btrim(i.alt_text)) < 8
               or i.alt_text ~* '^(image|photo|picture|img|product|untitled)\\M'
               or i.alt_text ~* '\\.(jpe?g|png|webp|gif|avif)$'
               or lower(btrim(i.alt_text)) = lower(btrim(p.title)))
      )`,
      detail: sql`(select count(*)::text || ' of ' || (select count(*) from product_images x where x.product_id = p.id)::text
                   from product_images i
                   where i.product_id = p.id
                     and (char_length(btrim(i.alt_text)) < 8
                          or i.alt_text ~* '^(image|photo|picture|img|product|untitled)\\M'
                          or i.alt_text ~* '\\.(jpe?g|png|webp|gif|avif)$'
                          or lower(btrim(i.alt_text)) = lower(btrim(p.title))))`,
    }),
    issue(executor, statuses, {
      id: "no_offer",
      label: "Nothing a shopper can buy",
      explanation:
        "With no live variant there is no price to state, so the listing cannot carry a product rich result.",
      severity: "required",
      where: sql`not exists (
        select 1 from product_variants v where v.product_id = p.id and v.archived_at is null and v.is_enabled
      )`,
    }),
    issue(executor, statuses, {
      id: "no_published_identifier",
      label: "No checked trade identifier",
      explanation:
        "A GTIN or MPN is what matches this page to the same product elsewhere. Only a verified or staff-entered one is published, so an unchecked legacy value does not count.",
      severity: "recommended",
      where: sql`not exists (
        select 1 from pkb_identifiers i
        where i.pkb_product_id = p.pkb_product_id
          and i.validation_status = 'valid'
          and i.verification_state in ('VERIFIED', 'MANUAL')
      )`,
    }),
    issue(executor, statuses, {
      id: "unresolved_identity",
      label: "Product identity not settled",
      explanation:
        "Until the knowledge base knows which product this is, its facts are not published to search engines and enrichment is refused.",
      severity: "recommended",
      where: sql`p.pkb_product_id is null or exists (
        select 1 from pkb_products kp
        where kp.id = p.pkb_product_id and kp.resolution_state in ('AMBIGUOUS', 'UNRESOLVED')
      )`,
      detail: sql`(select kp.resolution_state from pkb_products kp where kp.id = p.pkb_product_id)`,
    }),
    issue(executor, statuses, {
      id: "hidden_from_site_search",
      label: "Hidden from this site's search",
      explanation: "The listing is public but the search box will not find it. Sometimes deliberate, often not.",
      severity: "optional",
      where: sql`p.searchable = false`,
    }),
    issue(executor, statuses, {
      id: "foreign_canonical",
      label: "Canonical address pointing elsewhere",
      explanation:
        "A canonical on another domain tells search engines to show that page instead of this one. Since Stage 4 the editor refuses it; these are older values.",
      severity: "required",
      where: sql`p.canonical_url is not null and p.canonical_url <> '' and p.canonical_url !~ '^/'`,
      detail: sql`p.canonical_url`,
    }),
  ]);

  const [{ clean }] = await queryRows<{ clean: number }>(
    executor,
    sql`
      select count(*)::int as clean
      from products p
      where p.archived_at is null
        and p.status = any(${statuses}::text[])
        and p.seo_no_index = false
        and coalesce(btrim(p.seo_meta_title), '') <> ''
        and coalesce(btrim(p.seo_meta_description), '') <> ''
        and char_length(regexp_replace(coalesce(p.description_html, ''), '<[^>]*>', ' ', 'g')) >= 300
        and exists (select 1 from product_images i where i.product_id = p.id and i.kind = 'gallery')
        and exists (select 1 from product_variants v where v.product_id = p.id and v.archived_at is null and v.is_enabled)
    `,
  );

  return {
    publishedListings: counts?.published ?? 0,
    indexableListings: counts?.indexable ?? 0,
    issues: issues.filter((entry) => entry.count > 0).sort((a, b) => severityRank(a) - severityRank(b) || b.count - a.count),
    clean,
    structuredData: {
      withIdentifier: counts?.with_identifier ?? 0,
      withBrand: counts?.with_brand ?? 0,
      withOffer: counts?.with_offer ?? 0,
      withImage: counts?.with_image ?? 0,
    },
    redirects: counts?.redirects ?? 0,
    lockedFields: counts?.locked_fields ?? 0,
  };
}

function severityRank(issue: HealthIssue): number {
  return issue.severity === "required" ? 0 : issue.severity === "recommended" ? 1 : 2;
}
