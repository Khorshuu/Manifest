import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  pkbClaims,
  pkbIdentityDistinctions,
  pkbProducts,
  pkbResolutionHistory,
  type PkbResolutionState,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { PkbError, queryRows, type Executor } from "./common";
import { modelKey } from "./identifiers";
import { brandKey } from "./normalize";

/**
 * Product identity resolution (D-074).
 *
 * Before any factual enrichment, the knowledge base has to know exactly which
 * product it is enriching — the same name covers several generations,
 * regions, capacities and revisions. The state is:
 *
 *  - VERIFIED — a person confirmed the identity. Only ever set by a person,
 *    and dropped back to re-assessment when the identity signals it was
 *    confirmed against change.
 *  - HIGH_CONFIDENCE — a brand plus a valid GTIN or a model/part number, no
 *    other product sharing them, and no conflicting identifier claims.
 *  - AMBIGUOUS — another product shares the brand and model number (or the
 *    exact name), or identifier claims disagree. Candidates are listed.
 *  - UNRESOLVED — not enough identity to tell (no brand, or no identifier).
 *
 * Enrichment from external sources proceeds only from VERIFIED or
 * HIGH_CONFIDENCE. Deterministic signals only; no similarity guesses decide
 * identity.
 */

export type ResolutionReason = { code: string; message: string; candidateIds?: string[] };

export type ProductIdentity = {
  pkbProductId: string;
  name: string;
  brands: { id: string; name: string; key: string }[];
  modelName: string | null;
  generation: string | null;
  modelKeys: string[];
  gtins: { gtin14: string; pkbVariantId: string | null }[];
};

export type ResolutionAssessment = {
  state: PkbResolutionState;
  reasons: ResolutionReason[];
  candidates: { pkbProductId: string; name: string; matchedOn: string }[];
  signature: string;
};

export function canEnrich(state: PkbResolutionState): boolean {
  return state === "VERIFIED" || state === "HIGH_CONFIDENCE";
}

export async function loadIdentity(executor: Executor, pkbProductId: string): Promise<ProductIdentity | null> {
  const [product] = await executor.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
  if (!product) return null;
  const facts = await queryRows<{ key: string; raw_value: string | null; brand_id: string | null; brand_name: string | null }>(
    executor,
    sql`select d.key, f.raw_value, b.id as brand_id, b.name as brand_name
        from pkb_facts f
        join pkb_attribute_definitions d on d.id = f.definition_id
        left join pkb_brands b on b.id = f.value_brand_id
        where f.pkb_product_id = ${pkbProductId} and f.pkb_variant_id is null
          and d.key in ('brand', 'model_name', 'generation')`,
  );
  const identifiers = await queryRows<{ identifier_type: string; value_normalized: string | null; gtin14: string | null; pkb_variant_id: string | null }>(
    executor,
    sql`select identifier_type, value_normalized, gtin14, pkb_variant_id from pkb_identifiers
        where pkb_product_id = ${pkbProductId} and validation_status <> 'invalid'`,
  );
  return {
    pkbProductId,
    name: product.name,
    brands: facts
      .filter((row) => row.key === "brand" && row.brand_id)
      .map((row) => ({ id: row.brand_id!, name: row.brand_name!, key: brandKey(row.brand_name!) })),
    modelName: facts.find((row) => row.key === "model_name")?.raw_value ?? null,
    generation: facts.find((row) => row.key === "generation")?.raw_value ?? null,
    modelKeys: [
      ...new Set(
        identifiers
          .filter((row) => (row.identifier_type === "mpn" || row.identifier_type === "model_number") && row.value_normalized)
          .map((row) => row.value_normalized!),
      ),
    ],
    gtins: identifiers.filter((row) => row.gtin14).map((row) => ({ gtin14: row.gtin14!, pkbVariantId: row.pkb_variant_id })),
  };
}

function signatureOf(identity: ProductIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.brands.map((brand) => brand.id).sort(),
        [...identity.modelKeys].sort(),
        identity.gtins.map((gtin) => gtin.gtin14).sort(),
        identity.generation ? modelKey(identity.generation) : null,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export async function assessResolution(executor: Executor, pkbProductId: string): Promise<ResolutionAssessment> {
  const identity = await loadIdentity(executor, pkbProductId);
  if (!identity) throw new PkbError("That product is not in the knowledge base.", 404);
  const signature = signatureOf(identity);
  const reasons: ResolutionReason[] = [];

  const [product] = await executor.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
  const confirmedSignature = (product.resolutionReasons as { signature?: string } | null)?.signature;
  if (product.resolutionState === "VERIFIED" && confirmedSignature === signature) {
    return {
      state: "VERIFIED",
      reasons: [{ code: "confirmed", message: "A person confirmed this identity and the identity has not changed since." }],
      candidates: [],
      signature,
    };
  }

  // Other products sharing the brand and a model number, or the exact name.
  const distinct = new Set(
    (
      await executor
        .select()
        .from(pkbIdentityDistinctions)
        .where(or(eq(pkbIdentityDistinctions.productAId, pkbProductId), eq(pkbIdentityDistinctions.productBId, pkbProductId)))
    ).map((row: { productAId: string; productBId: string }) => (row.productAId === pkbProductId ? row.productBId : row.productAId)),
  );
  const candidates: ResolutionAssessment["candidates"] = [];
  if (identity.brands.length > 0) {
    const brandIds = identity.brands.map((brand) => brand.id);
    const rows = await queryRows<{ id: string; name: string; matched_on: string }>(
      executor,
      sql`select p.id, p.name,
                 case when exists (
                   select 1 from pkb_identifiers i
                   where i.pkb_product_id = p.id and i.identifier_type in ('mpn', 'model_number')
                     and i.value_normalized = any(${`{${identity.modelKeys.join(",")}}`}::text[])
                 ) then 'model number' else 'name' end as matched_on
          from pkb_products p
          where p.id <> ${pkbProductId} and p.status = 'active'
            and exists (
              select 1 from pkb_facts f join pkb_attribute_definitions d on d.id = f.definition_id
              where f.pkb_product_id = p.id and d.key = 'brand' and f.value_brand_id = any(${`{${brandIds.join(",")}}`}::uuid[])
            )
            and (
              exists (
                select 1 from pkb_identifiers i
                where i.pkb_product_id = p.id and i.identifier_type in ('mpn', 'model_number')
                  and i.value_normalized = any(${`{${identity.modelKeys.join(",")}}`}::text[])
              )
              or lower(p.name) = lower(${identity.name})
            )
          limit 20`,
    );
    for (const row of rows) {
      if (!distinct.has(row.id)) candidates.push({ pkbProductId: row.id, name: row.name, matchedOn: row.matched_on });
    }
  }

  const conflictingIdentifiers = await executor
    .select({ id: pkbClaims.id, identifierType: pkbClaims.identifierType })
    .from(pkbClaims)
    .where(
      and(
        eq(pkbClaims.pkbProductId, pkbProductId),
        eq(pkbClaims.targetKind, "identifier"),
        eq(pkbClaims.status, "CONFLICT"),
      ),
    );

  let state: PkbResolutionState;
  if (conflictingIdentifiers.length > 0) {
    reasons.push({ code: "conflicting_identifier_claims", message: "Sources disagree about this product's identifiers." });
  }
  if (candidates.length > 0) {
    reasons.push({
      code: "similar_products",
      message: `${candidates.length} other product${candidates.length === 1 ? " shares" : "s share"} this brand and model number or name.`,
      candidateIds: candidates.map((candidate) => candidate.pkbProductId),
    });
  }
  if (reasons.length > 0) {
    state = "AMBIGUOUS";
  } else if (identity.brands.length === 0) {
    state = "UNRESOLVED";
    reasons.push({ code: "no_brand", message: "No brand is recorded." });
  } else if (identity.brands.length > 1) {
    state = "AMBIGUOUS";
    reasons.push({ code: "several_brands", message: "More than one brand is recorded." });
  } else if (identity.gtins.length === 0 && identity.modelKeys.length === 0) {
    state = "UNRESOLVED";
    reasons.push({ code: "no_identifier", message: "No valid GTIN and no model or part number is recorded." });
  } else {
    state = "HIGH_CONFIDENCE";
    reasons.push({
      code: "identified",
      message: identity.gtins.length > 0 ? "Brand and a valid GTIN, shared with no other product." : "Brand and a model or part number, shared with no other product.",
    });
  }
  return { state, reasons, candidates, signature };
}

/** Re-assesses and stores the state, recording a history row when it changes. */
export async function refreshResolution(executor: Executor, pkbProductId: string): Promise<ResolutionAssessment> {
  const assessment = await assessResolution(executor, pkbProductId);
  const [product] = await executor.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
  const stored = { signature: assessment.signature, reasons: assessment.reasons };
  if (product.resolutionState !== assessment.state) {
    await executor.insert(pkbResolutionHistory).values({
      pkbProductId,
      fromState: product.resolutionState,
      toState: assessment.state,
      reasons: assessment.reasons,
      note: product.resolutionState === "VERIFIED" ? "The confirmed identity changed; re-assessed." : null,
    });
  }
  await executor
    .update(pkbProducts)
    .set({
      resolutionState: assessment.state,
      resolutionReasons: assessment.state === "VERIFIED" ? product.resolutionReasons : stored,
      resolutionCheckedAt: new Date(),
      ...(assessment.state === "VERIFIED" ? {} : { resolutionDecidedBy: null, resolutionDecidedAt: null }),
    })
    .where(eq(pkbProducts.id, pkbProductId));
  return assessment;
}

/**
 * Re-assesses one product's resolution at somebody's request (Stage 8).
 *
 * `refreshResolution` above takes an executor rather than an actor, because
 * every other caller is already inside a gated write: accepting a claim about
 * an identifier, or an enrichment run. The admin screen's "check again" button
 * had no such gate — it reached `refreshResolution` directly, so any staff
 * account could write the knowledge base: the state, a history row, and, where
 * the state is no longer VERIFIED, the confirmed-identity decision, cleared.
 * Invariant I-14 says every knowledge mutation asks for permission inside
 * `lib/`, so this is where it asks.
 *
 * `catalog.manage` is the permission every other resolution write uses, and
 * re-assessing is a write however much it reads like a refresh.
 */
export async function reassessResolution(
  actor: SessionUser | null,
  pkbProductId: string,
): Promise<ResolutionAssessment> {
  requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    // The lock the other writers take, so two people pressing the button at
    // once cannot each append a history row for the same change.
    const [product] = await tx.select({ id: pkbProducts.id }).from(pkbProducts).where(eq(pkbProducts.id, pkbProductId)).for("update");
    if (!product) throw new PkbError("That product is not in the knowledge base.", 404);
    return refreshResolution(tx, pkbProductId);
  });
}

/**
 * A person resolves the identity: confirms it, stating any candidates are
 * different products. Refused while sources still disagree about identifiers —
 * those claims are resolved first.
 */
export async function confirmIdentity(
  actor: SessionUser | null,
  pkbProductId: string,
  input: { distinctFrom?: string[]; note: string },
) {
  const staff = requirePermission(actor, "catalog.manage");
  const note = input.note.trim();
  if (note.length < 5) throw new PkbError("Say briefly how you confirmed which product this is.");

  return db.transaction(async (tx) => {
    const [product] = await tx.select().from(pkbProducts).where(eq(pkbProducts.id, pkbProductId)).for("update");
    if (!product) throw new PkbError("That product is not in the knowledge base.", 404);

    for (const otherId of input.distinctFrom ?? []) {
      if (otherId === pkbProductId) continue;
      const [a, b] = [pkbProductId, otherId].sort();
      await tx.insert(pkbIdentityDistinctions).values({ productAId: a, productBId: b, decidedBy: staff.id, note }).onConflictDoNothing();
    }

    const assessment = await assessResolution(tx, pkbProductId);
    const blocking = assessment.reasons.filter((reason) => reason.code === "conflicting_identifier_claims" || reason.code === "similar_products");
    if (blocking.length > 0) {
      throw new PkbError(`Resolve first: ${blocking.map((reason) => reason.message).join(" ")}`, 409, { reasons: blocking });
    }

    const now = new Date();
    await tx.insert(pkbResolutionHistory).values({
      pkbProductId,
      fromState: product.resolutionState,
      toState: "VERIFIED",
      reasons: assessment.reasons,
      actorUserId: staff.id,
      note,
    });
    await tx
      .update(pkbProducts)
      .set({
        resolutionState: "VERIFIED",
        resolutionReasons: { signature: assessment.signature, reasons: [{ code: "confirmed", message: note }] },
        resolutionCheckedAt: now,
        resolutionDecidedBy: staff.id,
        resolutionDecidedAt: now,
        updatedAt: now,
      })
      .where(eq(pkbProducts.id, pkbProductId));
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.identity_resolved", entityType: "pkb_product", entityId: pkbProductId, before: { state: product.resolutionState }, after: { state: "VERIFIED", distinctFrom: input.distinctFrom ?? [] } },
      tx,
    );
  });
}

export async function resolutionHistory(executor: Executor, pkbProductId: string) {
  return executor
    .select()
    .from(pkbResolutionHistory)
    .where(eq(pkbResolutionHistory.pkbProductId, pkbProductId))
    .orderBy(sql`${pkbResolutionHistory.createdAt} desc`)
    .limit(20);
}
