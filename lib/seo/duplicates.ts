import { sql } from "drizzle-orm";
import { db } from "@/db";
import { PUBLIC_STATUSES } from "@/lib/catalog";
import { queryRows, type Executor } from "@/lib/pkb/common";

/**
 * Duplicate and thin content (D-086).
 *
 * Two kinds of problem, both measurable from the shop's own rows.
 *
 * *Duplicate* — several listings carrying the same words. Search engines pick
 * one of them and drop the rest, and the shop has no say in which. This
 * happens honestly: a listing is duplicated to save typing, a range of sizes
 * gets one description, a category's generated sentence is the same everywhere.
 *
 * *Thin* — a page with too little on it to answer anything. Under this heading
 * the module counts what is actually there (characters of readable text, key
 * features, specifications) rather than judging the writing.
 *
 * Nothing here rewrites anything. Rewording is a person's decision, and the
 * knowledge base — not this module — is where product facts come from.
 *
 * ## How the comparison stays cheap
 *
 * Exact matches are found by grouping on the normalized value, which migration
 * 0035 indexes. Near-duplicates are found by bucketing on the first 160
 * characters of the stripped body and comparing only inside a bucket, so the
 * work is proportional to the catalogue rather than to its square.
 */

export type DuplicateGroup = {
  /** What is shared: "seo_meta_title", "seo_meta_description", "title", "description". */
  field: string;
  label: string;
  /** The shared value, shortened for display. */
  value: string;
  listings: { id: string; title: string; slug: string }[];
};

export type ThinListing = {
  id: string;
  title: string;
  slug: string;
  /** Why it counts as thin, in plain words. */
  reason: string;
};

export type DuplicateReport = {
  groups: DuplicateGroup[];
  nearDuplicateDescriptions: DuplicateGroup[];
  thin: ThinListing[];
  /** Categories whose page has nothing written on it of its own. */
  categoriesWithoutCopy: { id: string; name: string; slug: string }[];
};

const GROUP_LIMIT = 20;
const MEMBER_LIMIT = 8;

/** The comparable form of a body of copy: tags out, punctuation and case out. */
const STRIPPED = (column: string) =>
  sql.raw(`regexp_replace(lower(regexp_replace(coalesce(${column}, ''), '<[^>]*>', ' ', 'g')), '[^a-z0-9]+', ' ', 'g')`);

type GroupRow = { value: string; ids: string[]; titles: string[]; slugs: string[] };

async function exactGroups(
  executor: Executor,
  statuses: string,
  field: string,
  label: string,
  expression: ReturnType<typeof sql>,
  where: ReturnType<typeof sql>,
): Promise<DuplicateGroup[]> {
  const rows = await queryRows<GroupRow>(
    executor,
    sql`
      select ${expression} as value,
             array_agg(p.id::text order by p.updated_at desc) as ids,
             array_agg(p.title order by p.updated_at desc) as titles,
             array_agg(p.slug order by p.updated_at desc) as slugs
      from products p
      where p.archived_at is null
        and p.status = any(${statuses}::text[])
        and p.seo_no_index = false
        and (${where})
      group by ${expression}
      having count(*) > 1
      order by count(*) desc
      limit ${GROUP_LIMIT}
    `,
  );

  return rows.map((row) => ({
    field,
    label,
    value: row.value.length > 120 ? `${row.value.slice(0, 117)}…` : row.value,
    listings: row.ids.slice(0, MEMBER_LIMIT).map((id, index) => ({
      id,
      title: row.titles[index],
      slug: row.slugs[index],
    })),
  }));
}

/**
 * Everything duplicated or thin across the published catalogue.
 *
 * Read-only; the caller checks the permission, because this is a catalogue-wide
 * read and the screens that use it already require `catalog.manage`.
 */
export async function duplicateReport(executor: Executor = db): Promise<DuplicateReport> {
  const statuses = `{${PUBLIC_STATUSES.join(",")}}`;

  const [metaTitles, metaDescriptions, titles, descriptions, near, thin, categories] = await Promise.all([
    exactGroups(
      executor,
      statuses,
      "seo_meta_title",
      "The same SEO title",
      sql`lower(btrim(p.seo_meta_title))`,
      sql`p.seo_meta_title is not null and btrim(p.seo_meta_title) <> ''`,
    ),
    exactGroups(
      executor,
      statuses,
      "seo_meta_description",
      "The same meta description",
      sql`lower(btrim(p.seo_meta_description))`,
      sql`p.seo_meta_description is not null and btrim(p.seo_meta_description) <> ''`,
    ),
    exactGroups(
      executor,
      statuses,
      "title",
      "The same product name",
      sql`lower(btrim(p.title))`,
      sql`true`,
    ),
    exactGroups(
      executor,
      statuses,
      "description",
      "The same description, word for word",
      sql`btrim(${STRIPPED("p.description_html")})`,
      sql`char_length(btrim(${STRIPPED("p.description_html")})) >= 40`,
    ),
    nearDuplicateDescriptions(executor, statuses),
    thinListings(executor, statuses),
    categoriesWithoutCopy(executor),
  ]);

  return {
    groups: [...metaTitles, ...metaDescriptions, ...titles, ...descriptions],
    nearDuplicateDescriptions: near,
    thin,
    categoriesWithoutCopy: categories,
  };
}

/**
 * Bodies that open with the same 160 characters but are not identical — the
 * shape a template leaves behind: one paragraph reused, a detail swapped in
 * near the end. Reported separately from an exact duplicate because the fix is
 * different: these need the opening rewritten, not the page deleted.
 */
async function nearDuplicateDescriptions(executor: Executor, statuses: string): Promise<DuplicateGroup[]> {
  const rows = await queryRows<GroupRow & { distinct_bodies: number }>(
    executor,
    sql`
      with bodies as (
        select p.id, p.title, p.slug, p.updated_at,
               btrim(${STRIPPED("p.description_html")}) as body
        from products p
        where p.archived_at is null
          and p.status = any(${statuses}::text[])
          and p.seo_no_index = false
          and char_length(btrim(${STRIPPED("p.description_html")})) >= 160
      )
      select min(left(body, 160)) as value,
             count(distinct body)::int as distinct_bodies,
             array_agg(id::text order by updated_at desc) as ids,
             array_agg(title order by updated_at desc) as titles,
             array_agg(slug order by updated_at desc) as slugs
      from bodies
      -- Grouped on the hash of the opening rather than the opening itself, so
      -- the grouping key stays short whatever the copy is. The body is
      -- trimmed before the prefix is taken, so this does not match migration
      -- 0035's index exactly: the description checks are a scan of the
      -- published listings, which is measured in Stage 7 (risk R-10).
      group by md5(left(body, 160))
      having count(*) > 1 and count(distinct body) > 1
      order by count(*) desc
      limit ${GROUP_LIMIT}
    `,
  );

  return rows.map((row) => ({
    field: "description_opening",
    label: "Descriptions that open identically",
    value: `${row.value.slice(0, 117)}…`,
    listings: row.ids.slice(0, MEMBER_LIMIT).map((id, index) => ({
      id,
      title: row.titles[index],
      slug: row.slugs[index],
    })),
  }));
}

/** Published pages with too little on them to answer a shopper's question. */
async function thinListings(executor: Executor, statuses: string): Promise<ThinListing[]> {
  return queryRows<ThinListing>(
    executor,
    sql`
      select p.id::text as id, p.title, p.slug,
             case
               when char_length(btrim(${STRIPPED("p.description_html")})) < 120 then
                 char_length(btrim(${STRIPPED("p.description_html")})) || ' characters of description'
               else 'little beyond the description: ' ||
                 (case when jsonb_typeof(p.bullet_features) = 'array' then jsonb_array_length(p.bullet_features) else 0 end) || ' key feature(s), ' ||
                 (case when jsonb_typeof(p.spec_table) = 'array' then jsonb_array_length(p.spec_table) else 0 end) || ' specification(s)'
             end as reason
      from products p
      where p.archived_at is null
        and p.status = any(${statuses}::text[])
        and p.seo_no_index = false
        and (
          char_length(btrim(${STRIPPED("p.description_html")})) < 120
          or (
            char_length(btrim(${STRIPPED("p.description_html")})) < 300
            and (case when jsonb_typeof(p.bullet_features) = 'array' then jsonb_array_length(p.bullet_features) else 0 end) < 3
            and (case when jsonb_typeof(p.spec_table) = 'array' then jsonb_array_length(p.spec_table) else 0 end) < 3
          )
        )
      order by p.updated_at desc
      limit 50
    `,
  );
}

/**
 * Shelves with nothing of their own to read. Until a shelf has its own
 * sentence, every one of them says the same thing with a word swapped, which
 * is the shop generating its own duplicate content (D-084).
 */
async function categoriesWithoutCopy(executor: Executor): Promise<{ id: string; name: string; slug: string }[]> {
  return queryRows<{ id: string; name: string; slug: string }>(
    executor,
    sql`
      select c.id::text as id, c.name, c.slug
      from categories c
      where c.seo_no_index = false
        and (c.intro_html is null or btrim(c.intro_html) = '')
        and (c.seo_meta_description is null or btrim(c.seo_meta_description) = '')
      order by c.name
      limit 50
    `,
  );
}

/**
 * What one listing shares with others — the same four checks, asked from a
 * single listing's side so the editor can show them beside the fields.
 */
export async function listingDuplication(
  productId: string,
  executor: Executor = db,
): Promise<{ field: string; label: string; shared: string; with: { id: string; title: string }[] }[]> {
  const statuses = `{${PUBLIC_STATUSES.join(",")}}`;
  const rows = await queryRows<{ field: string; shared: string; id: string; title: string }>(
    executor,
    sql`
      with mine as (select * from products where id = ${productId})
      select f.field, f.shared, other.id::text as id, other.title
      from mine
      cross join lateral (
        values
          ('seo_meta_title', lower(btrim(mine.seo_meta_title))),
          ('seo_meta_description', lower(btrim(mine.seo_meta_description))),
          ('title', lower(btrim(mine.title))),
          ('description', btrim(${STRIPPED("mine.description_html")}))
      ) as f(field, shared)
      join products other on other.id <> mine.id
        and other.archived_at is null
        and other.status = any(${statuses}::text[])
        and case f.field
          when 'seo_meta_title' then lower(btrim(other.seo_meta_title)) = f.shared
          when 'seo_meta_description' then lower(btrim(other.seo_meta_description)) = f.shared
          when 'title' then lower(btrim(other.title)) = f.shared
          else btrim(${STRIPPED("other.description_html")}) = f.shared
        end
      where f.shared is not null and char_length(f.shared) >= 8
      order by f.field, other.title
      limit 40
    `,
  );

  const labels: Record<string, string> = {
    seo_meta_title: "SEO title",
    seo_meta_description: "Meta description",
    title: "Product name",
    description: "Description",
  };

  const grouped = new Map<string, { field: string; label: string; shared: string; with: { id: string; title: string }[] }>();
  for (const row of rows) {
    const group = grouped.get(row.field) ?? {
      field: row.field,
      label: labels[row.field] ?? row.field,
      shared: row.shared.length > 120 ? `${row.shared.slice(0, 117)}…` : row.shared,
      with: [],
    };
    if (group.with.length < MEMBER_LIMIT) group.with.push({ id: row.id, title: row.title });
    grouped.set(row.field, group);
  }
  return [...grouped.values()];
}
