/**
 * The Intelligence workspace.
 *
 * The consolidation is an information-architecture change, so what is worth
 * asserting is not how the screens look but the three things that could go
 * wrong quietly: a role seeing a tab it may not open, an overview figure that
 * is not a count of anything real, and a deep link that silently loses its
 * filter. The reads the workspace is built on are checked here against a real
 * database; the browser behaviour is in e2e/intelligence.spec.ts.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pkbBrands, pkbProducts, productPreparationRuns, products, users } from "@/db/schema";
import { AuthorizationError, can, ROLE_PERMISSIONS, type StaffRole } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import { knowledgeAttention, listIdentities } from "@/lib/pkb/intelligence";
import { decideRegistryEntry, suggestBrandRelation, suggestRegistryEntry } from "@/lib/pkb/trust";
import { listPreparationRuns, preparationSummary } from "@/lib/preparation";
import { INTELLIGENCE_PERMISSIONS, INTELLIGENCE_TABS } from "@/app/admin/intelligence/tabs";
import {
  isKnowledgeFocus,
  isSeoPulseFilter,
  isSeoSeverity,
  searchPeriod,
  SEO_PULSE_FILTERS,
} from "@/app/admin/intelligence/filters";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };
let categoryId = "";
let runs = 0;

/** A user of one staff role. `can` reads the role, not the database. */
const asRole = (role: StaffRole): SessionUser => ({ id: "", email: `${role}@example.com`, role });

/** Which tabs a role is offered, by exactly the rule the layout applies. */
function tabsFor(user: SessionUser) {
  return INTELLIGENCE_TABS.filter((tab) =>
    tab.permissions.some((permission) => can(user, permission)),
  ).map((tab) => tab.label);
}

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const rows = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });
  staff.id = rows.find((row) => row.email === "staff@example.com")!.id;
  customer.id = rows.find((row) => row.email === "shopper@example.com")!.id;
  const category = await createCategory(staff, { name: "Audio", slug: "audio" });
  categoryId = category.id;
});

async function listing(title: string) {
  const created = await createProduct(staff, { title, categoryId });
  const [row] = await harness.db.select().from(products).where(eq(products.id, created.id));
  return row;
}

/** A finished stage must record when it finished — migration 0043 checks it. */
const FINISHED = new Set(["READY", "FAILED", "BLOCKED", "CANCELLED"]);

async function preparationRun(productId: string, stage: string) {
  await harness.db.insert(productPreparationRuns).values({
    productId,
    stage: stage as never,
    finishedAt: FINISHED.has(stage) ? new Date() : null,
    requestKey: `00000000-0000-4000-8000-${String(++runs).padStart(12, "0")}`,
    requestedBy: staff.id,
    review:
      stage === "NEEDS_REVIEW"
        ? [
            {
              code: "CLAIMS_WAITING",
              message: "Two values need a decision.",
              remedy: "Accept or reject them.",
            },
          ]
        : [],
    failure:
      stage === "FAILED"
        ? {
            code: "CONTENT_FAILED",
            message: "The content step did not finish.",
            remedy: "Try again.",
          }
        : null,
  });
}

describe("tab visibility follows the existing permissions", () => {
  it("offers the owner every tab", () => {
    expect(tabsFor(asRole("super_admin"))).toEqual([
      "Overview",
      "SeoPulse",
      "Product Knowledge",
      "SearchPulse",
      "SEO Health",
      "Search Console",
      "Sources & Policies",
    ]);
  });

  it("offers marketing only the tabs its permissions open", () => {
    // Marketing holds search.manage and seo.view, not catalog.manage: it gets
    // the overview, site search and Search Console, and no catalogue tab.
    expect(tabsFor(asRole("marketing"))).toEqual(["Overview", "SearchPulse", "Search Console"]);
  });

  it("offers a role with no intelligence permission nothing at all", () => {
    for (const role of ["order_manager", "support", "finance"] as const) {
      expect(tabsFor(asRole(role))).toEqual([]);
    }
  });

  it("offers a customer nothing", () => {
    expect(tabsFor(customer)).toEqual([]);
  });

  it("gates the workspace on exactly the permissions its tabs need", () => {
    const needed = new Set(INTELLIGENCE_TABS.flatMap((tab) => tab.permissions));
    expect([...needed].sort()).toEqual([...INTELLIGENCE_PERMISSIONS].sort());
  });

  it("does not widen any role", () => {
    // The consolidation must not have added a permission to a role in order to
    // make a tab reachable. This is the table as it stood before it.
    expect(ROLE_PERMISSIONS.marketing).not.toContain("catalog.manage");
    expect(ROLE_PERMISSIONS.support).not.toContain("seo.view");
    expect(ROLE_PERMISSIONS.finance).not.toContain("search.manage");
  });
});

describe("deep-link parameters", () => {
  it("accepts the filters the overview links with, and rejects anything else", () => {
    for (const filter of Object.keys(SEO_PULSE_FILTERS)) {
      expect(isSeoPulseFilter(filter)).toBe(true);
    }
    expect(isSeoPulseFilter("everything")).toBe(false);
    expect(isSeoPulseFilter(undefined)).toBe(false);

    expect(isKnowledgeFocus("conflicts")).toBe(true);
    expect(isKnowledgeFocus("unresolved")).toBe(true);
    expect(isKnowledgeFocus("nonsense")).toBe(false);

    expect(isSeoSeverity("required")).toBe(true);
    expect(isSeoSeverity("critical")).toBe(false);

    expect(searchPeriod("90")).toBe(90);
    expect(searchPeriod("1")).toBe(30);
    expect(searchPeriod(undefined)).toBe(30);
  });

  it("maps every SeoPulse filter to real preparation stages", async () => {
    const waiting = await listing("Harbor HP-900");
    await preparationRun(waiting.id, "NEEDS_REVIEW");
    const blocked = await listing("Harbor HP-800");
    await preparationRun(blocked.id, "BLOCKED");

    const review = await listPreparationRuns(staff, { stages: SEO_PULSE_FILTERS["needs-review"] });
    expect(review.map((row) => row.productId)).toEqual([waiting.id]);
    expect(review[0].headline).toBe("Two values need a decision.");

    const stopped = await listPreparationRuns(staff, { stages: SEO_PULSE_FILTERS.blocked });
    expect(stopped.map((row) => row.productId)).toEqual([blocked.id]);
  });
});

describe("overview figures come from real queries", () => {
  it("counts preparation runs by stage", async () => {
    const a = await listing("Harbor HP-900");
    const b = await listing("Harbor HP-800");
    const c = await listing("Harbor HP-700");
    await preparationRun(a.id, "NEEDS_REVIEW");
    await preparationRun(b.id, "FAILED");
    await preparationRun(c.id, "READY");

    const summary = await preparationSummary(staff);
    const byStage = new Map(summary.map((row) => [row.stage, Number(row.total)]));
    expect(byStage.get("NEEDS_REVIEW")).toBe(1);
    expect(byStage.get("FAILED")).toBe(1);
    expect(byStage.get("READY")).toBe(1);
    expect(byStage.get("BLOCKED")).toBeUndefined();
  });

  it("reports a failed run in the words the backend wrote, not an error string", async () => {
    const product = await listing("Harbor HP-900");
    await preparationRun(product.id, "FAILED");
    const [row] = await listPreparationRuns(staff, { stages: ["FAILED"] });
    expect(row.headline).toBe("The content step did not finish.");
    expect(row.productTitle).toBe("Harbor HP-900");
    expect(row.requestedBy).toBe("staff@example.com");
  });

  it("counts identities, suggested sources and brand relations", async () => {
    const product = await listing("Harbor HP-900");
    const pkbProductId = product.pkbProductId!;

    const fresh = await knowledgeAttention(staff);
    expect(fresh.unresolvedIdentities).toBe(1);
    expect(fresh.ambiguousIdentities).toBe(0);
    expect(fresh.suggestedSources).toBe(0);
    expect(fresh.suggestedBrandRelations).toBe(0);

    await harness.db
      .update(pkbProducts)
      .set({ resolutionState: "AMBIGUOUS" })
      .where(eq(pkbProducts.id, pkbProductId));

    const brands = await harness.db
      .insert(pkbBrands)
      .values([
        { name: "Harbor", nameNormalized: "harbor", slug: "harbor", origin: "MANUAL_ADMIN" },
        {
          name: "Harbor Audio",
          nameNormalized: "harbor audio",
          slug: "harbor-audio",
          origin: "MANUAL_ADMIN",
        },
      ])
      .returning({ id: pkbBrands.id, name: pkbBrands.name });
    const brandId = brands.find((row) => row.name === "Harbor")!.id;
    const relatedBrandId = brands.find((row) => row.name === "Harbor Audio")!.id;

    await suggestRegistryEntry(staff, {
      brandId,
      role: "official_documentation",
      domain: "docs.harbor.test",
    });
    await suggestBrandRelation(staff, { brandId, relatedBrandId, kind: "subsidiary_of" });

    const attention = await knowledgeAttention(staff);
    expect(attention.ambiguousIdentities).toBe(1);
    expect(attention.unresolvedIdentities).toBe(0);
    expect(attention.suggestedSources).toBe(1);
    expect(attention.suggestedBrandRelations).toBe(1);
    expect(attention.conflicts).toBe(0);
    expect(attention.openClaims).toBe(0);

    const ambiguous = await listIdentities(staff, "AMBIGUOUS");
    expect(ambiguous.map((row) => row.listingId)).toEqual([product.id]);
    expect(ambiguous[0].title).toBe("Harbor HP-900");
    expect(await listIdentities(staff, "UNRESOLVED")).toEqual([]);
  });

  it("stops counting a source once it is approved", async () => {
    const [brand] = await harness.db
      .insert(pkbBrands)
      .values({ name: "Harbor", nameNormalized: "harbor", slug: "harbor", origin: "MANUAL_ADMIN" })
      .returning({ id: pkbBrands.id });
    const entry = await suggestRegistryEntry(staff, {
      brandId: brand.id,
      role: "official_documentation",
      domain: "docs.harbor.test",
    });
    expect((await knowledgeAttention(staff)).suggestedSources).toBe(1);

    await decideRegistryEntry(staff, entry.id, "approved");
    expect((await knowledgeAttention(staff)).suggestedSources).toBe(0);
  });
});

describe("server authorization is unchanged", () => {
  it("refuses a customer every read the workspace makes", async () => {
    await expect(knowledgeAttention(customer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(listIdentities(customer, "UNRESOLVED")).rejects.toBeInstanceOf(AuthorizationError);
    await expect(listPreparationRuns(customer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(preparationSummary(customer)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses a staff role without the catalogue permission", async () => {
    const marketing = asRole("marketing");
    await expect(knowledgeAttention(marketing)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(listPreparationRuns(marketing)).rejects.toBeInstanceOf(AuthorizationError);
  });
});
