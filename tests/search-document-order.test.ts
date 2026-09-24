/**
 * Stage 8: the search document is built in a fixed order.
 *
 * `refresh_product_search` used to aggregate a listing's shelf specifications
 * with `string_agg(…, ' ')` and no ORDER BY, so the order of those words was
 * whatever the plan produced. That is stable for one call shape and different
 * for another: on the 5,000-listing scale database, refreshing every listing in
 * one call and refreshing them in chunks of two hundred — which is what the
 * queue worker does — stored different documents for 3,863 of 5,000 listings
 * with nothing about the catalogue changed.
 *
 * It mattered twice. Relevance within a tier uses `ts_rank_cd`, a cover-density
 * rank that reads positions out of the tsvector, so the same query against the
 * same data could order two listings differently depending only on how the
 * index had last been rebuilt. And a derived read model that cannot be rebuilt
 * to the same bytes cannot be compared against the canonical data it is derived
 * from, which is the check this model exists to pass (invariant I-21).
 *
 * Two tests, because behaviour alone cannot catch this. The first reads the
 * function as the database holds it and fails when any aggregate in it can
 * return rows in an arbitrary order — that is the guard, and it covers
 * aggregates added later. The second says what the order is.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productSearch, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createCategoryAttribute, updateProduct } from "@/lib/catalog";
import { queryRows } from "@/lib/pkb/common";
import { createTestDatabase } from "./helpers/database";
import { createProductForTest } from "./helpers/catalog";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [staffRow] = await harness.db
    .insert(users)
    .values([{ email: staff.email, passwordHash: "x", role: "staff_admin" }])
    .returning();
  staff.id = staffRow.id;
  const shelf = await createCategory(staff, { name: "Machines", slug: "machines" });
  categoryId = shelf.id;
});

/** The stored words for one listing, and the document as text. */
async function stored(productId: string) {
  const [row] = await harness.db
    .select({ textC: productSearch.textC, document: sql<string>`${productSearch.document}::text` })
    .from(productSearch)
    .where(sql`${productSearch.productId} = ${productId}`);
  return row;
}

describe("the search document", () => {
  it("is aggregated in a declared order everywhere in refresh_product_search", async () => {
    const [{ body }] = await queryRows<{ body: string }>(
      harness.db,
      sql`select prosrc as body from pg_proc where proname = 'refresh_product_search'`,
    );

    // Every aggregate whose result depends on the order its input rows arrive
    // in: string_agg, array_agg and jsonb_agg. `DISTINCT` is enough on its own
    // — PostgreSQL sorts to deduplicate — and so is an explicit ORDER BY.
    const unordered: string[] = [];
    for (const match of body.matchAll(/(string_agg|array_agg|jsonb_agg)\s*\(/g)) {
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let at = open; at < body.length; at += 1) {
        if (body[at] === "(") depth += 1;
        else if (body[at] === ")") {
          depth -= 1;
          if (depth === 0) {
            close = at;
            break;
          }
        }
      }
      const call = body.slice(match.index, close + 1);
      // Only this call's own arguments count, not a nested aggregate's.
      const ordered = /\bORDER\s+BY\b/i.test(call) || /\(\s*DISTINCT\b/i.test(call);
      if (!ordered) unordered.push(call.replace(/\s+/g, " ").slice(0, 120));
    }

    expect(unordered).toEqual([]);
  });

  it("puts a shelf's specifications in the shelf's own order, however the refresh was called", async () => {
    // `sort_order` is assigned in the order the shelf's specifications are
    // created, and these names are deliberately not in alphabetical order, so
    // the shelf's order is its own and not a coincidence of the names.
    const specs = [
      { name: "Wheels", value: "Four" },
      { name: "Colour", value: "Black" },
      { name: "Alloy", value: "Steel" },
      { name: "Range", value: "Long" },
      { name: "Boot", value: "Large" },
    ];
    const created: { id: string; name: string; value: string }[] = [];
    for (const spec of specs) {
      const definition = await createCategoryAttribute(staff, categoryId, {
        name: spec.name,
        dataType: "text",
        isSearchable: true,
      });
      created.push({ id: definition.id, name: spec.name, value: spec.value });
    }

    const attributeValues = Object.fromEntries(created.map((spec) => [spec.id, spec.value]));
    const first = await createProductForTest(staff, {
      title: "Everyday Machine",
      categoryId,
      status: "preorder_open",
    });
    const second = await createProductForTest(staff, {
      title: "Weekend Machine",
      categoryId,
      status: "preorder_open",
    });
    await updateProduct(staff, first.id, { attributeValues });
    await updateProduct(staff, second.id, { attributeValues });

    const expected = created.map((spec) => `${spec.name} ${spec.value}`).join(" ");

    // Refreshed on its own, as the deferred trigger does for one save.
    await harness.db.execute(sql`select refresh_product_search(array[${first.id}::uuid])`);
    const alone = await stored(first.id);
    expect(alone.textC).toContain(expected);

    // Refreshed in a batch, as the queue worker does.
    await harness.db.execute(
      sql`select refresh_product_search(array[${first.id}::uuid, ${second.id}::uuid])`,
    );
    const batched = await stored(first.id);
    expect(batched.textC).toContain(expected);

    // And the same bytes either way, which is what makes the model comparable
    // to the canonical data behind it.
    expect(batched.textC).toBe(alone.textC);
    expect(batched.document).toBe(alone.document);
  });
});
