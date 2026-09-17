import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  pkbBrandRelations,
  pkbBrands,
  pkbClaims,
  pkbEvidence,
  pkbFacts,
  pkbProducts,
  pkbSourceRegistry,
  pkbSources,
  pkbVerificationPolicies,
  type PkbRegistryRole,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { PkbError, queryRows, type Executor } from "./common";
import { hostnameProblem } from "./net/address";
import { sameStoredValue, type FactRow } from "./store";

/**
 * Source trust (A-4, A-9, D-072).
 *
 * A brand existing says nothing about which sources speak for it. Trust is a
 * registry entry — a domain or a feed, for one brand or for all, with a role
 * and the authority that role carries — and every entry starts `suggested`.
 * Only an entry someone with `knowledge.manage` approved gives a source any
 * authority, and only a verification policy decides what authority is enough
 * for VERIFIED.
 */

export const ROLE_TIERS: Record<PkbRegistryRole, 1 | 2 | 3 | null> = {
  official_product: 1,
  official_support: 1,
  official_documentation: 1,
  manufacturer_feed: 1,
  authorized_distributor: 2,
  trusted_retailer: 2,
  product_database: 2,
  supplier_feed: 2,
  approved_secondary: 3,
  blocked: null,
};

export const ROLE_LABELS: Record<PkbRegistryRole, string> = {
  official_product: "Official product site",
  official_support: "Official support site",
  official_documentation: "Official documentation",
  manufacturer_feed: "Manufacturer feed",
  authorized_distributor: "Authorized distributor",
  trusted_retailer: "Trusted retailer",
  product_database: "Product database",
  supplier_feed: "Supplier feed",
  approved_secondary: "Approved secondary source",
  blocked: "Blocked",
};

/** A registry domain: lowercase, no scheme, no `www.`, a real public name. */
export function normalizeRegistryDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  let host = trimmed;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new PkbError("Enter a domain such as sony.com.");
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  const problem = hostnameProblem(host);
  if (problem) throw new PkbError(`That domain is ${problem}.`);
  return host;
}

export type RegistryEntryInput = {
  brandId: string | null;
  role: PkbRegistryRole;
  domain?: string | null;
  pathPrefix?: string | null;
  providerKey?: string | null;
  urlTemplate?: string | null;
  preference?: number;
  note?: string | null;
  evidenceSourceId?: string | null;
};

const TEMPLATE_FIELDS = ["model_key", "model", "mpn", "gtin"];

/** Suggests a registry entry. It carries no authority until approved. */
export async function suggestRegistryEntry(actor: SessionUser | null, input: RegistryEntryInput) {
  const staff = requirePermission(actor, "catalog.manage");
  const matchKind = input.providerKey ? "provider" : "domain";
  const domain = matchKind === "domain" ? normalizeRegistryDomain(input.domain ?? "") : null;
  const pathPrefix = input.pathPrefix?.trim() ? `/${input.pathPrefix.trim().replace(/^\/+/, "")}` : null;

  if (input.urlTemplate) {
    if (!domain || input.role === "blocked") throw new PkbError("Only a trusted domain can have a product address template.");
    const placeholders = [...input.urlTemplate.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
    if (placeholders.length === 0 || placeholders.some((name) => !TEMPLATE_FIELDS.includes(name))) {
      throw new PkbError("A template uses {model_key}, {model}, {mpn} or {gtin}.");
    }
    let host: string;
    try {
      const sample = new URL(input.urlTemplate.replace(/\{[a-z_]+\}/g, "x"));
      if (sample.protocol !== "https:") throw new Error();
      host = sample.hostname.replace(/^www\./, "");
    } catch {
      throw new PkbError("A template must be an https address.");
    }
    if (host !== domain && !host.endsWith(`.${domain}`)) throw new PkbError("A template must point at the entry's own domain.");
  }
  if (input.brandId) {
    const [brand] = await db.select({ id: pkbBrands.id }).from(pkbBrands).where(eq(pkbBrands.id, input.brandId));
    if (!brand) throw new PkbError("That brand does not exist.", 404);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(pkbSourceRegistry)
      .values({
        brandId: input.brandId,
        matchKind,
        domain,
        pathPrefix,
        providerKey: input.providerKey?.trim() || null,
        role: input.role,
        authorityTier: ROLE_TIERS[input.role],
        preference: input.preference ?? 100,
        urlTemplate: input.urlTemplate?.trim() || null,
        status: "suggested",
        origin: "MANUAL_ADMIN",
        evidenceSourceId: input.evidenceSourceId ?? null,
        note: input.note?.slice(0, 500) ?? null,
        createdBy: staff.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new PkbError("That entry is already suggested or approved.", 409);
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.registry_suggested", entityType: "pkb_registry", entityId: row.id, after: { domain, role: input.role, brandId: input.brandId } },
      tx,
    );
    return row;
  });
}

/** Approves or rejects a suggested entry. Trust is a person's decision. */
export async function decideRegistryEntry(actor: SessionUser | null, entryId: string, decision: "approved" | "rejected" | "retired") {
  const staff = requirePermission(actor, "knowledge.manage");
  return db.transaction(async (tx) => {
    const [entry] = await tx.select().from(pkbSourceRegistry).where(eq(pkbSourceRegistry.id, entryId)).for("update");
    if (!entry) throw new PkbError("That registry entry does not exist.", 404);
    const allowed = decision === "retired" ? entry.status === "approved" : entry.status === "suggested";
    if (!allowed) throw new PkbError(`A ${entry.status} entry cannot be ${decision}.`, 409);
    const now = new Date();
    const [row] = await tx
      .update(pkbSourceRegistry)
      .set(
        decision === "retired"
          ? { status: "retired", updatedAt: now }
          : { status: decision, decidedBy: staff.id, decidedAt: now, updatedAt: now },
      )
      .where(eq(pkbSourceRegistry.id, entryId))
      .returning();
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.registry_decided", entityType: "pkb_registry", entityId: entryId, before: { status: entry.status }, after: { status: decision } },
      tx,
    );
    return row;
  });
}

export async function suggestBrandRelation(
  actor: SessionUser | null,
  input: { brandId: string; relatedBrandId: string; kind: "manufactured_by" | "subsidiary_of" | "formerly_known_as"; note?: string | null },
) {
  const staff = requirePermission(actor, "catalog.manage");
  if (input.brandId === input.relatedBrandId) throw new PkbError("A brand cannot be related to itself.");
  const [row] = await db
    .insert(pkbBrandRelations)
    .values({ ...input, status: "suggested", origin: "MANUAL_ADMIN", createdBy: staff.id, note: input.note ?? null })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new PkbError("That relation is already recorded.", 409);
  return row;
}

export async function decideBrandRelation(actor: SessionUser | null, relationId: string, decision: "approved" | "rejected") {
  const staff = requirePermission(actor, "knowledge.manage");
  const [row] = await db
    .update(pkbBrandRelations)
    .set({ status: decision, decidedBy: staff.id, decidedAt: new Date() })
    .where(and(eq(pkbBrandRelations.id, relationId), eq(pkbBrandRelations.status, "suggested")))
    .returning();
  if (!row) throw new PkbError("Only a suggested relation can be decided.", 409);
  return row;
}

// ------------------------------------------------------------------ policies

export async function setPolicyStatus(actor: SessionUser | null, policyId: string, status: "active" | "retired") {
  const staff = requirePermission(actor, "knowledge.manage");
  return db.transaction(async (tx) => {
    const [policy] = await tx.select().from(pkbVerificationPolicies).where(eq(pkbVerificationPolicies.id, policyId)).for("update");
    if (!policy) throw new PkbError("That policy does not exist.", 404);
    if (status === "active" && policy.status !== "draft") throw new PkbError("Only a draft policy can be activated.", 409);
    if (status === "retired" && policy.status !== "active") throw new PkbError("Only an active policy can be retired.", 409);
    const now = new Date();
    const [row] = await tx
      .update(pkbVerificationPolicies)
      .set(status === "active" ? { status, activatedAt: now, activatedBy: staff.id, updatedAt: now } : { status, updatedAt: now })
      .where(eq(pkbVerificationPolicies.id, policyId))
      .returning();
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.policy_changed", entityType: "pkb_policy", entityId: policyId, before: { status: policy.status }, after: { status } },
      tx,
    );
    return row;
  });
}

// ------------------------------------------------------------------ evaluation

export type RegistryMatch = {
  entryId: string;
  role: PkbRegistryRole;
  tier: 1 | 2 | 3 | null;
  blocked: boolean;
  brandSpecific: boolean;
};

type RegistryRow = typeof pkbSourceRegistry.$inferSelect;

/** The brands whose approved registry entries speak for a product: its brand and approved manufacturer relations. */
export async function trustedBrandIds(executor: Executor, pkbProductId: string): Promise<string[]> {
  const brands = await queryRows<{ id: string }>(
    executor,
    sql`select distinct f.value_brand_id as id from pkb_facts f
        join pkb_attribute_definitions d on d.id = f.definition_id
        where f.pkb_product_id = ${pkbProductId} and d.key = 'brand' and f.value_brand_id is not null`,
  );
  const ids = brands.map((row) => row.id);
  if (ids.length === 0) return [];
  const related = await queryRows<{ id: string }>(
    executor,
    sql`select related_brand_id as id from pkb_brand_relations
        where status = 'approved' and kind in ('manufactured_by', 'subsidiary_of')
          and brand_id = any(${`{${ids.join(",")}}`}::uuid[])`,
  );
  return [...new Set([...ids, ...related.map((row) => row.id)])];
}

export async function approvedRegistryFor(executor: Executor, brandIds: string[]): Promise<RegistryRow[]> {
  return executor
    .select()
    .from(pkbSourceRegistry)
    .where(
      and(
        eq(pkbSourceRegistry.status, "approved"),
        brandIds.length > 0 ? or(isNull(pkbSourceRegistry.brandId), inArray(pkbSourceRegistry.brandId, brandIds)) : isNull(pkbSourceRegistry.brandId),
      ),
    );
}

/** How the registry classifies one source. A blocked entry wins over any trust. */
export function matchRegistry(
  entries: RegistryRow[],
  source: { domain: string | null; url: string | null; providerKey: string | null },
): RegistryMatch | null {
  const path = (() => {
    try {
      return source.url ? new URL(source.url).pathname : "/";
    } catch {
      return "/";
    }
  })();
  const host = source.domain?.replace(/^www\./, "") ?? null;
  const applicable = entries.filter((entry) => {
    if (entry.matchKind === "provider") return Boolean(source.providerKey) && entry.providerKey === source.providerKey;
    if (!host || !entry.domain) return false;
    const hostMatches = host === entry.domain || host.endsWith(`.${entry.domain}`);
    return hostMatches && (!entry.pathPrefix || path.startsWith(entry.pathPrefix));
  });
  if (applicable.length === 0) return null;
  const blocked = applicable.find((entry) => entry.role === "blocked");
  if (blocked) return { entryId: blocked.id, role: "blocked", tier: null, blocked: true, brandSpecific: blocked.brandId !== null };
  const best = [...applicable].sort(
    (a, b) =>
      (a.authorityTier ?? 9) - (b.authorityTier ?? 9) ||
      Number(b.brandId !== null) - Number(a.brandId !== null) ||
      a.preference - b.preference,
  )[0];
  return { entryId: best.id, role: best.role, tier: (best.authorityTier ?? null) as 1 | 2 | 3 | null, blocked: false, brandSpecific: best.brandId !== null };
}

export type SourceAssessment = {
  sourceId: string;
  claimId: string;
  domain: string | null;
  sourceType: string;
  acquisitionMethod: string;
  extractionMethod: string;
  registry: RegistryMatch | null;
  attestedBy: string | null;
};

export type VerificationQualification = {
  eligible: boolean;
  policy: { key: string; name: string } | null;
  reasons: string[];
  sources: SourceAssessment[];
};

type ClaimRow = typeof pkbClaims.$inferSelect;

/**
 * Whether a claim may be accepted as VERIFIED, and under which policy. Pure
 * reading: nothing is written. The claim and every open or accepted claim that
 * says the same thing for the same slot count as corroboration; independence
 * is by registry entry, domain or feed, so two pages of one site are one source.
 */
export async function evaluateVerification(executor: Executor, claimId: string): Promise<VerificationQualification> {
  const [claim]: ClaimRow[] = await executor.select().from(pkbClaims).where(eq(pkbClaims.id, claimId));
  if (!claim) throw new PkbError("That claim does not exist.", 404);
  const reasons: string[] = [];
  if (claim.status === "CONFLICT") {
    return { eligible: false, policy: null, reasons: ["The slot has conflicting claims. Resolve the conflict first."], sources: [] };
  }
  if (claim.status !== "SUGGESTED") {
    return { eligible: false, policy: null, reasons: [`The claim is already ${claim.status.toLowerCase()}.`], sources: [] };
  }

  const sameSlot: ClaimRow[] = await executor
    .select()
    .from(pkbClaims)
    .where(
      and(
        eq(pkbClaims.pkbProductId, claim.pkbProductId),
        claim.pkbVariantId ? eq(pkbClaims.pkbVariantId, claim.pkbVariantId) : isNull(pkbClaims.pkbVariantId),
        claim.targetKind === "fact" ? eq(pkbClaims.definitionId, claim.definitionId!) : eq(pkbClaims.identifierType, claim.identifierType!),
        eq(pkbClaims.ordinal, claim.ordinal),
        inArray(pkbClaims.status, ["SUGGESTED", "ACCEPTED"]),
      ),
    );
  const agreeing = sameSlot.filter((other) =>
    claim.targetKind === "identifier"
      ? other.identifierNormalized === claim.identifierNormalized
      : sameStoredValue(other as unknown as FactRow, {
          valueStatus: claim.valueStatus,
          rawValue: claim.rawValue,
          rawUnit: claim.rawUnit,
          rawLabel: null,
          typed: {
            text: claim.valueText,
            number: claim.valueNumber,
            numberMax: claim.valueNumberMax,
            unit: claim.valueUnit,
            boolean: claim.valueBoolean,
            date: claim.valueDate,
            optionId: claim.valueOptionId,
            brandName: null,
          },
          brandId: claim.valueBrandId,
          failure: null,
        }),
  );

  const rows: {
    claimId: string;
    sourceId: string;
    domain: string | null;
    url: string | null;
    providerKey: string | null;
    sourceType: string;
    acquisitionMethod: string;
    extractionMethod: string;
    createdBy: string | null;
  }[] = await executor
    .select({
      claimId: pkbClaims.id,
      sourceId: pkbSources.id,
      domain: pkbSources.domain,
      url: pkbSources.url,
      providerKey: pkbSources.providerKey,
      sourceType: pkbSources.sourceType,
      acquisitionMethod: pkbSources.acquisitionMethod,
      extractionMethod: pkbEvidence.extractionMethod,
      createdBy: pkbSources.createdBy,
    })
    .from(pkbClaims)
    .innerJoin(pkbEvidence, eq(pkbEvidence.id, pkbClaims.evidenceId))
    .innerJoin(pkbSources, eq(pkbSources.id, pkbEvidence.sourceId))
    .where(inArray(pkbClaims.id, agreeing.map((row) => row.id)));

  const brandIds = await trustedBrandIds(executor, claim.pkbProductId);
  const registry = await approvedRegistryFor(executor, brandIds);
  const sources: SourceAssessment[] = rows.map((row) => ({
    sourceId: row.sourceId,
    claimId: row.claimId,
    domain: row.domain,
    sourceType: row.sourceType,
    acquisitionMethod: row.acquisitionMethod,
    extractionMethod: row.extractionMethod,
    registry: matchRegistry(registry, row),
    attestedBy: row.createdBy,
  }));

  if (sources.some((source) => source.registry?.blocked)) {
    reasons.push("A source for this value is on a blocked domain; blocked sources never support verification.");
  }

  const [product] = await executor.select({ familyId: pkbProducts.familyId }).from(pkbProducts).where(eq(pkbProducts.id, claim.pkbProductId));
  const familyLineage = product?.familyId
    ? (
        await queryRows<{ id: string }>(
          executor,
          sql`with recursive up as (select id, parent_id, 0 as depth from pkb_families where id = ${product.familyId}
              union all select f.id, f.parent_id, up.depth + 1 from pkb_families f join up on f.id = up.parent_id where up.depth < 16)
              select id from up`,
        )
      ).map((row) => row.id)
    : [];

  const policies: (typeof pkbVerificationPolicies.$inferSelect)[] = await executor
    .select()
    .from(pkbVerificationPolicies)
    .where(eq(pkbVerificationPolicies.status, "active"));
  const applicable = policies
    .filter((policy) => policy.appliesTo === "any" || policy.appliesTo === claim.targetKind)
    .filter((policy) => !policy.definitionId || policy.definitionId === claim.definitionId)
    .filter((policy) => !policy.familyId || familyLineage.includes(policy.familyId))
    // The most specific policy speaks first.
    .sort((a, b) => Number(Boolean(b.definitionId)) - Number(Boolean(a.definitionId)) || Number(Boolean(b.familyId)) - Number(Boolean(a.familyId)) || a.key.localeCompare(b.key));

  if (applicable.length === 0) reasons.push("No active verification policy applies to this value.");

  for (const policy of applicable) {
    const qualifying = sources.filter((source) => {
      if (source.registry?.blocked) return false;
      if (!policy.qualifyingSourceTypes.includes(source.sourceType as never)) return false;
      if (source.extractionMethod === "ai_assisted" && !policy.allowAiAssisted) return false;
      if (source.sourceType === "admin_official_document" && !source.attestedBy) return false;
      if (policy.registryRoles && policy.registryRoles.length > 0) {
        if (!source.registry || !policy.registryRoles.includes(source.registry.role)) return false;
        if (policy.maxAuthorityTier !== null && (source.registry.tier === null || source.registry.tier > policy.maxAuthorityTier)) return false;
      }
      return true;
    });
    const independent = new Set(qualifying.map((source) => source.registry?.entryId ?? source.domain ?? source.sourceId));
    if (independent.size >= policy.minIndependentSources && !sources.some((source) => source.registry?.blocked)) {
      return { eligible: true, policy: { key: policy.key, name: policy.name }, reasons: [], sources };
    }
    reasons.push(
      qualifying.length === 0
        ? `${policy.name}: no source qualifies${policy.registryRoles ? " (it needs an approved registry entry for this brand)" : ""}.`
        : `${policy.name}: needs ${policy.minIndependentSources} independent qualifying sources, has ${independent.size}.`,
    );
  }
  return { eligible: false, policy: null, reasons, sources };
}

/** The claims of a product that qualify for VERIFIED right now — a preview, not an action. */
export async function qualifyingClaims(executor: Executor, pkbProductId: string) {
  const open: { id: string; definitionId: string | null; identifierType: string | null }[] = await executor
    .select({ id: pkbClaims.id, definitionId: pkbClaims.definitionId, identifierType: pkbClaims.identifierType })
    .from(pkbClaims)
    .where(and(eq(pkbClaims.pkbProductId, pkbProductId), eq(pkbClaims.status, "SUGGESTED")));
  const locked = new Set(
    (
      await executor
        .select({ definitionId: pkbFacts.definitionId })
        .from(pkbFacts)
        .where(and(eq(pkbFacts.pkbProductId, pkbProductId), sql`${pkbFacts.lockedAt} is not null`))
    ).map((row: { definitionId: string }) => row.definitionId),
  );
  const results: { claimId: string; policy: { key: string; name: string } }[] = [];
  for (const claim of open) {
    if (claim.definitionId && locked.has(claim.definitionId)) continue;
    const qualification = await evaluateVerification(executor, claim.id);
    if (qualification.eligible && qualification.policy) results.push({ claimId: claim.id, policy: qualification.policy });
  }
  return results;
}
