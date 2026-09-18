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
/**
 * How many listings one per-listing check will look at before it stops. A
 * bounded example list, not a count: the screens that report how widespread a
 * duplicate is read the catalogue-wide grouping instead (risk R-10).
 */
const CANDIDATE_LIMIT = 50;

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
  /** What to group on, when it is cheaper than the value itself. */
  groupBy: ReturnType<typeof sql> = expression,
): Promise<DuplicateGroup[]> {
  const rows = await queryRows<GroupRow>(
    executor,
    sql`
      select min(${expression}) as value,
             array_agg(p.id::text order by p.updated_at desc) as ids,
             array_agg(p.title order by p.updated_at desc) as titles,
             array_agg(p.slug order by p.updated_at desc) as slugs
      from products p
      where p.archived_at is null
        and p.status = any(${statuses}::text[])
        and p.seo_no_index = false
        and (${where})
      group by ${groupBy}
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
      sql`p.description_html is not null and char_length(btrim(${STRIPPED("p.description_html")})) >= 40`,
      // Grouped on the hash of the body rather than the body itself: migration
      // 0038 indexes exactly this expression, and a grouping key of a few bytes
      // beats one of several thousand (risk R-10).
      sql`md5(btrim(${STRIPPED("p.description_html")}))`,
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
          and p.description_html is not null
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
      -- the grouping key stays short whatever the copy is. The body is trimmed
      -- before the prefix is taken; migration 0035's index was on the untrimmed
      -- text and so never matched this, which is why migration 0038 replaces it
      -- with one on this exact expression (risk R-10).
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

  /*
   * The listing's own values first, then one indexed lookup per field (R-10).
   *
   * This runs in the product editor on every load. Its first form asked the
   * whole question in one statement with a `CASE` inside the join, so which
   * field was being compared was decided per candidate row and no expression
   * index could be used; the description branch stripped the HTML of every
   * published listing. That measured 197 ms on the 5,000-listing scale
   * database. Asking it as one statement with the listing in a CTE was worse
   * still — 1,347 ms — because the value compared against was not a constant,
   * so the planner looped over the catalogue four times.
   *
   * Reading this listing's values into the process first makes each comparison
   * an equality against a parameter, which is exactly what the expression
   * indexes in migrations 0035 and 0038 are for. Four small statements, each an
   * index lookup. The comparable form of the description is computed here with
   * the same rules the SQL uses, and matched on its hash, because a hash is
   * what can be indexed; the full text is compared as well, so a hash
   * collision cannot invent a duplicate.
   */
  const [mine] = await queryRows<{
    id: string;
    title: string;
    seo_meta_title: string | null;
    seo_meta_description: string | null;
    body: string;
  }>(
    executor,
    sql`
      select id::text as id, title, seo_meta_title, seo_meta_description,
             btrim(${STRIPPED("description_html")}) as body
      from products where id = ${productId}
    `,
  );
  if (!mine) return [];

  const comparable = (value: string | null) => (value ?? "").trim().toLowerCase();

  const checks: { field: string; shared: string; run: () => Promise<{ id: string; title: string }[]> }[] = [
    {
      field: "seo_meta_title",
      shared: comparable(mine.seo_meta_title),
      run: () =>
        queryRows(
          executor,
          sql`select other.id::text as id, other.title from products other
              where other.id <> ${productId}::uuid and other.archived_at is null
                and other.status = any(${statuses}::text[])
                and lower(btrim(other.seo_meta_title)) = ${comparable(mine.seo_meta_title)}
              order by other.title limit ${MEMBER_LIMIT}`,
        ),
    },
    {
      field: "seo_meta_description",
      shared: comparable(mine.seo_meta_description),
      run: () =>
        queryRows(
          executor,
          sql`select other.id::text as id, other.title from products other
              where other.id <> ${productId}::uuid and other.archived_at is null
                and other.status = any(${statuses}::text[])
                and lower(btrim(other.seo_meta_description)) = ${comparable(mine.seo_meta_description)}
              order by other.title limit ${MEMBER_LIMIT}`,
        ),
    },
    {
      field: "title",
      shared: comparable(mine.title),
      run: () =>
        queryRows(
          executor,
          sql`select other.id::text as id, other.title from products other
              where other.id <> ${productId}::uuid and other.archived_at is null
                and other.status = any(${statuses}::text[])
                and lower(btrim(other.title)) = ${comparable(mine.title)}
              order by other.title limit ${MEMBER_LIMIT}`,
        ),
    },
    {
      field: "description",
      shared: mine.body,
      run: () =>
        queryRows(
          executor,
          /*
           * Two details make this bounded rather than catalogue-wide.
           *
           * `description_html is not null` is not redundant: migration 0038
           * indexes only those rows, and a partial index cannot be used without
           * its own predicate. Leaving it out cost a sequential scan of the
           * published catalogue — 391 ms on the scale database.
           *
           * And the candidates are capped before the full text is compared. The
           * hash match is what the index answers; confirming it needs the
           * comparable form computed again per row, and a catalogue where
           * thousands of listings share one description would pay that
           * thousands of times to fill a list of eight. This screen exists to
           * say "this copy is not unique", which ${CANDIDATE_LIMIT} examples
           * establish as well as five thousand.
           */
          sql`select id::text as id, title from (
                select other.id, other.title, other.description_html
                from products other
                where other.id <> ${productId}::uuid and other.archived_at is null
                  and other.description_html is not null
                  and other.status = any(${statuses}::text[])
                  and md5(btrim(${STRIPPED("other.description_html")})) = md5(${mine.body}::text)
                limit ${CANDIDATE_LIMIT}
              ) candidates
              where btrim(${STRIPPED("candidates.description_html")}) = ${mine.body}
              order by title limit ${MEMBER_LIMIT}`,
        ),
    },
  ];

  const found = await Promise.all(
    checks.map(async (check) =>
      // Too short to be a meaningful duplicate: two blank meta descriptions are
      // not "the same copy", they are two listings with none.
      check.shared.length >= 8 ? { ...check, with: await check.run() } : { ...check, with: [] },
    ),
  );

  const labels: Record<string, string> = {
    seo_meta_title: "SEO title",
    seo_meta_description: "Meta description",
    title: "Product name",
    description: "Description",
  };

  return found
    .filter((check) => check.with.length > 0)
    .map((check) => ({
      field: check.field,
      label: labels[check.field] ?? check.field,
      shared: check.shared.length > 120 ? `${check.shared.slice(0, 117)}…` : check.shared,
      with: check.with,
    }));
}
