/**
 * D-128, against a real database: bulk decisions go through the ordinary
 * acceptance and rejection paths with every guarantee they carry, and
 * generated SKUs are short, unique, within 64 characters, separate from the
 * manufacturer's identifiers, and never replace a SKU staff wrote.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attributeValues, auditLog, pkbClaims, productVariants, products, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  createCategory,
  createProduct,
  createProductOption,
  duplicateProduct,
  generateVariants,
  updateProduct,
} from "@/lib/catalog";
import { renameProductOptionValue } from "@/lib/catalog/attributes";
import { updateVariant } from "@/lib/catalog/variants";
import { recordEvidence, recordSource } from "@/lib/pkb/evidence";
import { acceptClaims, createClaim, rejectClaims } from "@/lib/pkb/review";
import { loadDefinitions } from "@/lib/pkb/vocabulary";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "verify@example.com", role: "staff_admin" };
const customer: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };
let categoryId = "";
let seq = 0;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [row] = await harness.db.insert(users).values({ email: staff.email, passwordHash: "x", role: "staff_admin" }).returning({ id: users.id });
  staff.id = row.id;
  const [shopper] = await harness.db.insert(users).values({ email: customer.email, passwordHash: "x", role: "customer" }).returning({ id: users.id });
  customer.id = shopper.id;
  categoryId = (await createCategory(staff, { name: `Things ${++seq}`, slug: `things-${seq}` })).id;
});

// --------------------------------------------------- bulk verification (37–43)

describe("deciding many proposed values", () => {
  async function productWithClaims(values: [string, string][]) {
    const product = await createProduct(staff, { categoryId, title: "Lumen Desk Lamp", brand: "Lumen" } as never);
    const [row] = await harness.db.select().from(products).where(eq(products.id, product.id));
    const pkbProductId = row.pkbProductId!;
    const sourceId = await recordSource(staff, {
      sourceType: "public_web",
      acquisitionMethod: "staff_url",
      origin: "APPROVED_EXTERNAL_SOURCE",
      url: "https://reviews.example.test/lumen-desk-lamp",
    });
    const definitions = await loadDefinitions(harness.db);
    const ids: string[] = [];
    for (const [key, raw] of values) {
      const definition = definitions.find((entry) => entry.key === key)!;
      const evidenceId = await recordEvidence(staff, { sourceId, pkbProductId, extractionMethod: "html_table", excerpt: `${definition.label}: ${raw}`, extractedLabel: definition.label, extractedValue: raw });
      const claim = await harness.db.transaction((tx) =>
        createClaim(tx, { pkbProductId, pkbVariantId: null, evidenceId, proposedBy: staff.id, proposedByRun: null, target: "fact", definition, raw }),
      );
      ids.push(claim.id);
    }
    return { pkbProductId, ids };
  }
  const statuses = async (ids: string[]) =>
    Object.fromEntries((await harness.db.select({ id: pkbClaims.id, status: pkbClaims.status }).from(pkbClaims).where(inArray(pkbClaims.id, ids))).map((row) => [row.id, row.status]));

  it("accepts and rejects what was selected through the ordinary paths, recording each one", async () => {
    const { pkbProductId, ids } = await productWithClaims([
      ["manufacturer", "Lumen Works"],
      ["model_name", "Beam"],
      ["generation", "Second"],
    ]);
    expect(await acceptClaims(staff, { claimIds: [ids[0], ids[1]] })).toMatchObject({ accepted: 2 });
    expect(await rejectClaims(staff, [ids[2]])).toBe(1);
    expect(await statuses(ids)).toEqual({ [ids[0]]: "ACCEPTED", [ids[1]]: "ACCEPTED", [ids[2]]: "REJECTED" });

    const decided = await harness.db.select().from(pkbClaims).where(inArray(pkbClaims.id, ids));
    expect(decided.every((claim) => claim.decidedBy === staff.id && claim.decidedAt)).toBe(true);
    const audits = await harness.db.select().from(auditLog).where(and(eq(auditLog.entityId, pkbProductId)));
    const accepted = audits.find((row) => row.action === "knowledge.claims_accepted");
    expect((accepted?.afterJson as { claims: string[] }).claims.sort()).toEqual([ids[0], ids[1]].sort());
    expect(audits.some((row) => row.action === "knowledge.claims_rejected")).toBe(true);
  });

  it("refuses a group with a stale item as a whole, and changes nothing in it", async () => {
    const { ids } = await productWithClaims([
      ["manufacturer", "Lumen Works"],
      ["model_name", "Beam"],
    ]);
    await acceptClaims(staff, { claimIds: [ids[0]] });
    await expect(acceptClaims(staff, { claimIds: [ids[0], ids[1]] })).rejects.toMatchObject({ status: 409 });
    expect(await statuses(ids)).toEqual({ [ids[0]]: "ACCEPTED", [ids[1]]: "SUGGESTED" });
  });

  it("keeps the permission check and the verification policy", async () => {
    const { ids } = await productWithClaims([["manufacturer", "Lumen Works"]]);
    await expect(acceptClaims(customer, { claimIds: ids })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(rejectClaims(customer, ids)).rejects.toBeInstanceOf(AuthorizationError);
    // A value read from an unapproved web page cannot be accepted as verified in bulk either.
    await expect(acceptClaims(staff, { claimIds: ids, asVerified: true })).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await statuses(ids)).toEqual({ [ids[0]]: "SUGGESTED" });
  });

  it("refuses more than 100 in one decision", async () => {
    const many = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    await expect(acceptClaims(staff, { claimIds: many })).rejects.toThrow(/at most 100/);
  });
});

// ---------------------------------------------------------------- SKUs (45–57)

describe("generated SKUs, stored", () => {
  const skus = async (productId: string) =>
    (await harness.db.select({ sku: productVariants.sku }).from(productVariants).where(eq(productVariants.productId, productId))).map((row) => row.sku).sort();

  it("gives a long-titled product a short primary SKU, never the title", async () => {
    const title = "Tessera Vx-70 Aurora ARGB Epic-Z RGB OC Triple Fan 12GB GDDR7 Graphics Card With A Very Long Name Indeed";
    const product = await createProduct(staff, { categoryId, title, brand: "Tessera" } as never);
    await generateVariants(staff, product.id, { priceBdt: 100 });
    const [sku] = await skus(product.id);
    expect(sku).toBe("TESSERA-VX70");
    expect(sku.length).toBeLessThanOrEqual(64);
  });

  it("uses the model number, keeps the manufacturer's identifiers separate, and tells variants apart", async () => {
    const product = await createProduct(staff, {
      categoryId,
      title: "Tessera Vx-70 Graphics Card",
      brand: "Tessera",
      details: { modelNumber: "VX70-12G" },
      identifierType: "mpn",
      identifierValue: "VX70-12G-OC",
    } as never);
    await createProductOption(staff, product.id, { name: "Colour", values: ["Black", "White"] });
    await generateVariants(staff, product.id, { priceBdt: 100 });
    expect(await skus(product.id)).toEqual(["TESSERA-VX7012G-BLACK", "TESSERA-VX7012G-WHITE"]);
    const [after] = await harness.db.select().from(products).where(eq(products.id, product.id));
    expect(after).toMatchObject({ identifierType: "mpn", identifierValue: "VX70-12G-OC" });
    expect(await skus(product.id)).not.toContain("VX70-12G-OC");
  });

  it("gives a second product with the same identity a short numbered SKU", async () => {
    const first = await createProduct(staff, { categoryId, title: "Lumen Beam Lamp 2", brand: "Lumen" } as never);
    const second = await createProduct(staff, { categoryId, title: "Lumen Beam Lamp 2", brand: "Lumen", slug: `lumen-beam-lamp-2-b` } as never);
    await generateVariants(staff, first.id, { priceBdt: 100 });
    await generateVariants(staff, second.id, { priceBdt: 100 });
    expect(await skus(first.id)).toEqual(["LUMEN-LAMP2"]);
    expect(await skus(second.id)).toEqual(["LUMEN-LAMP2-2"]);
  });

  it("follows a renamed option value while generated, and never touches a SKU staff wrote", async () => {
    const product = await createProduct(staff, { categoryId, title: "Lumen Beam Lamp", brand: "Lumen" } as never);
    const option = await createProductOption(staff, product.id, { name: "Colour", values: ["Blk", "Wht"] });
    await generateVariants(staff, product.id, { priceBdt: 100 });
    const variants = await harness.db.select().from(productVariants).where(eq(productVariants.productId, product.id));
    const white = variants.find((variant) => variant.sku.endsWith("WHT"))!;
    await updateVariant(staff, white.id, { sku: "STAFF-LAMP/white_01" });

    const values = await harness.db.select().from(attributeValues).where(eq(attributeValues.attributeId, option.id));
    const blk = values.find((value) => value.value === "Blk")!;
    const wht = values.find((value) => value.value === "Wht")!;
    await renameProductOptionValue(staff, blk.id, "Black");
    await renameProductOptionValue(staff, wht.id, "White");
    await updateProduct(staff, product.id, { title: "Lumen Beam Lamp Deluxe Edition" });

    expect(await skus(product.id)).toEqual(["LUMEN-BEAMLAMP-BLACK", "STAFF-LAMP/white_01"]);
  });

  it("keeps a duplicate's SKUs within 64 characters", async () => {
    const product = await createProduct(staff, { categoryId, title: "Lumen Beam Lamp", brand: "Lumen" } as never);
    await generateVariants(staff, product.id, { priceBdt: 100 });
    const [variant] = await harness.db.select().from(productVariants).where(eq(productVariants.productId, product.id));
    await updateVariant(staff, variant.id, { sku: "L".repeat(64) });
    const copy = await duplicateProduct(staff, product.id);
    const copied = await skus(copy.id);
    expect(copied[0].length).toBeLessThanOrEqual(64);
    expect(copied[0].endsWith("-COPY")).toBe(true);
  });
});
