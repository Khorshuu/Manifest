import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  pkbAttributeDefinitions,
  pkbClaims,
  pkbEvidence,
  pkbFacts,
  pkbProducts,
  pkbSources,
  pkbVariants,
  type PkbAcquisitionMethod,
  type PkbExtractionMethod,
  type PkbOrigin,
  type PkbSourceType,
  type PkbUsageRights,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { lockProductKnowledge, PkbError, staffChange, type Executor } from "./common";
import { valueWithUnit } from "./unit-text";
import { normalizeUrl } from "./normalize";
import {
  ensureBrand,
  notApplicableValue,
  readValue,
  sameStoredValue,
  valueColumns,
  type FactRow,
  type FactValue,
} from "./store";
import { loadDefinitions } from "./vocabulary";

/**
 * Sources, evidence and claims (D-062, D-063).
 *
 * A source is where information came from and how it was acquired — a
 * manufacturer page, a supplier feed, a document an admin uploaded, a URL
 * staff pasted. Evidence is a located passage in a source. A claim is a value
 * proposed for one attribute slot, always tied to evidence. None of these
 * changes a product's accepted facts; deciding claims is Stage 3's review.
 *
 * Acquisition is provider-agnostic (A-6): every source records its
 * `acquisition_method`, and nothing here fetches anything.
 */

/** Source types staff or providers may record. The two system types are written by the mirror only. */
const RECORDABLE_SOURCE_TYPES = new Set<PkbSourceType>([
  "manufacturer_website",
  "manufacturer_documentation",
  "manufacturer_support",
  "manufacturer_feed",
  "authorized_distributor",
  "retailer",
  "product_database",
  "supplier_feed",
  "supplier_document",
  "admin_official_document",
  "public_web",
  "research_provider",
  "other",
]);

export type RecordSourceInput = {
  sourceType: PkbSourceType;
  acquisitionMethod: PkbAcquisitionMethod;
  origin: PkbOrigin;
  usageRights?: PkbUsageRights;
  /** 1 official manufacturer · 2 distributor, trusted retailer, product database · 3 other approved. */
  authorityTier?: 1 | 2 | 3 | null;
  url?: string | null;
  title?: string | null;
  providerKey?: string | null;
  retrievedAt?: Date | null;
  contentSha256?: string | null;
  httpStatus?: number | null;
  robotsAllowed?: boolean | null;
};

export function sourceUrlParts(url: string): { url: string; normalized: string; domain: string } | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return { url: url.trim(), normalized: parsed.toString(), domain: parsed.hostname.replace(/^www\./, "") };
}

/**
 * Records a source, or returns the one already recorded for the same address
 * and content. Origin `UNKNOWN_LEGACY` is reserved for the legacy import.
 */
export async function recordSource(actor: SessionUser | null, input: RecordSourceInput): Promise<string> {
  const staff = requirePermission(actor, "catalog.manage");
  if (!RECORDABLE_SOURCE_TYPES.has(input.sourceType)) {
    throw new PkbError("That kind of source is recorded by the system, not by hand.");
  }
  if (input.origin === "UNKNOWN_LEGACY") throw new PkbError("A new source cannot have an unknown legacy origin.");
  if (input.acquisitionMethod === "legacy_import" || input.acquisitionMethod === "staff_entry") {
    throw new PkbError("That acquisition method is recorded by the system.");
  }

  const parts = input.url ? sourceUrlParts(input.url) : null;
  if (input.url && !parts) throw new PkbError("A source address must be an http(s) link.");

  return db.transaction(async (tx) => {
    if (parts) {
      const [existing] = await tx
        .select({ id: pkbSources.id })
        .from(pkbSources)
        .where(
          and(
            eq(pkbSources.urlNormalized, parts.normalized),
            input.contentSha256 ? eq(pkbSources.contentSha256, input.contentSha256) : isNull(pkbSources.contentSha256),
          ),
        );
      if (existing) return existing.id;
    }
    const [row] = await tx
      .insert(pkbSources)
      .values({
        sourceType: input.sourceType,
        acquisitionMethod: input.acquisitionMethod,
        origin: input.origin,
        usageRights: input.usageRights ?? "unknown",
        authorityTier: input.authorityTier ?? null,
        url: parts?.url ?? null,
        urlNormalized: parts?.normalized ?? null,
        domain: parts?.domain ?? null,
        title: input.title?.slice(0, 300) ?? null,
        providerKey: input.providerKey ?? null,
        retrievedAt: input.retrievedAt ?? null,
        contentSha256: input.contentSha256 ?? null,
        httpStatus: input.httpStatus ?? null,
        robotsAllowed: input.robotsAllowed ?? null,
        createdBy: staff.id,
      })
      .returning({ id: pkbSources.id });
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.source_recorded",
        entityType: "pkb_source",
        entityId: row.id,
        after: { sourceType: input.sourceType, acquisitionMethod: input.acquisitionMethod, domain: parts?.domain ?? null },
      },
      tx,
    );
    return row.id;
  });
}

export type RecordEvidenceInput = {
  sourceId: string;
  pkbProductId: string;
  extractionMethod: Exclude<PkbExtractionMethod, "legacy_import">;
  locator?: string | null;
  excerpt?: string | null;
  extractedLabel?: string | null;
  extractedValue?: string | null;
  extractedUnit?: string | null;
};

export async function recordEvidence(actor: SessionUser | null, input: RecordEvidenceInput): Promise<string> {
  const staff = requirePermission(actor, "catalog.manage");
  if ((input.extractionMethod as string) === "legacy_import") {
    throw new PkbError("Legacy evidence is recorded by the import only.");
  }
  const [source] = await db.select().from(pkbSources).where(eq(pkbSources.id, input.sourceId));
  if (!source) throw new PkbError("That source does not exist.", 404);
  const [row] = await db
    .insert(pkbEvidence)
    .values({
      sourceId: input.sourceId,
      pkbProductId: input.pkbProductId,
      extractionMethod: input.extractionMethod,
      locator: input.locator ?? null,
      excerpt: input.excerpt ?? null,
      extractedLabel: input.extractedLabel ?? null,
      extractedValue: input.extractedValue ?? null,
      extractedUnit: input.extractedUnit ?? null,
      createdBy: staff.id,
    })
    .returning({ id: pkbEvidence.id });
  return row.id;
}

export type ProposeFactClaimInput = {
  pkbProductId: string;
  pkbVariantId?: string | null;
  definitionId: string;
  ordinal?: number;
  evidenceId: string;
  raw?: string;
  unit?: string | null;
  notApplicable?: boolean;
  proposedByRun?: string | null;
};

function claimAsFact(claim: typeof pkbClaims.$inferSelect): FactRow {
  return claim as unknown as FactRow;
}

/**
 * Proposes a value for one slot. The claim is SUGGESTED, or CONFLICT when it
 * disagrees with the accepted value or with another open claim — in which case
 * those claims are marked CONFLICT too. A locked or manual value is never
 * touched: disagreement with it is exactly a conflict for a person to see.
 */
export async function proposeFactClaim(actor: SessionUser | null, input: ProposeFactClaimInput) {
  const staff = requirePermission(actor, "catalog.manage");
  const ordinal = input.ordinal ?? 0;

  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: pkbProducts.id }).from(pkbProducts).where(eq(pkbProducts.id, input.pkbProductId));
    if (!product) throw new PkbError("That product is not in the knowledge base.", 404);
    // A new claim is something a person must decide (D-127).
    await lockProductKnowledge(tx, product.id);
    if (input.pkbVariantId) {
      const [variant] = await tx
        .select({ id: pkbVariants.id })
        .from(pkbVariants)
        .where(and(eq(pkbVariants.id, input.pkbVariantId), eq(pkbVariants.pkbProductId, product.id)));
      if (!variant) throw new PkbError("That variant does not belong to this product.", 404);
    }
    const [evidence] = await tx.select().from(pkbEvidence).where(eq(pkbEvidence.id, input.evidenceId));
    if (!evidence || evidence.pkbProductId !== product.id) {
      throw new PkbError("A claim needs evidence recorded for the same product.", 400);
    }
    const [definition] = await loadDefinitions(tx, [input.definitionId]);
    if (!definition) throw new PkbError("That attribute does not exist.", 404);
    if (!input.notApplicable && !input.raw?.trim()) throw new PkbError("A claim needs a value.");

    // "2685 MHz" read with unit "MHz" is one unit, not two (D-128).
    const written = valueWithUnit(input.raw, input.unit);
    const value: FactValue = input.notApplicable ? notApplicableValue() : readValue(definition, written);
    if (value.valueStatus === "normalized" && value.typed.brandName) {
      value.brandId = await ensureBrand(tx, value.typed.brandName, staffChange(staff.id));
      value.typed = { ...value.typed, brandName: null };
    }
    if (!input.notApplicable) {
      value.rawValue = input.raw!.trim();
      value.rawUnit = input.unit ?? null;
    }

    const slot = and(
      eq(pkbFacts.pkbProductId, product.id),
      input.pkbVariantId ? eq(pkbFacts.pkbVariantId, input.pkbVariantId) : isNull(pkbFacts.pkbVariantId),
      eq(pkbFacts.definitionId, definition.id),
      eq(pkbFacts.ordinal, ordinal),
    );
    const [fact] = await tx.select().from(pkbFacts).where(slot);
    const open = await tx
      .select()
      .from(pkbClaims)
      .where(
        and(
          eq(pkbClaims.pkbProductId, product.id),
          input.pkbVariantId ? eq(pkbClaims.pkbVariantId, input.pkbVariantId) : isNull(pkbClaims.pkbVariantId),
          eq(pkbClaims.definitionId, definition.id),
          eq(pkbClaims.ordinal, ordinal),
          inArray(pkbClaims.status, ["SUGGESTED", "CONFLICT"]),
        ),
      );

    const disagreeing = open.filter((claim) => !sameStoredValue(claimAsFact(claim), value));
    const conflict = (fact !== undefined && !sameStoredValue(fact, value)) || disagreeing.length > 0;

    const { rawLabel: _rawLabel, ...columns } = valueColumns(value);
    void _rawLabel;
    const [claim] = await tx
      .insert(pkbClaims)
      .values({
        pkbProductId: product.id,
        pkbVariantId: input.pkbVariantId ?? null,
        targetKind: "fact",
        definitionId: definition.id,
        ordinal,
        evidenceId: evidence.id,
        ...columns,
        status: conflict ? "CONFLICT" : "SUGGESTED",
        proposedBy: staff.id,
        proposedByRun: input.proposedByRun ?? null,
      })
      .returning();

    if (disagreeing.length > 0) {
      await tx
        .update(pkbClaims)
        .set({ status: "CONFLICT", updatedAt: new Date() })
        .where(and(inArray(pkbClaims.id, disagreeing.map((row) => row.id)), ne(pkbClaims.status, "CONFLICT")));
    }

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.claim_proposed",
        entityType: "pkb_product",
        entityId: product.id,
        after: { claimId: claim.id, definition: definition.key, status: claim.status },
      },
      tx,
    );
    return claim;
  });
}

/** Evidence and claims recorded for a product, newest first. */
export async function listClaims(executor: Executor, pkbProductId: string) {
  return executor
    .select({
      claim: pkbClaims,
      sourceType: pkbSources.sourceType,
      acquisitionMethod: pkbSources.acquisitionMethod,
      authorityTier: pkbSources.authorityTier,
      origin: pkbSources.origin,
      domain: pkbSources.domain,
      extractionMethod: pkbEvidence.extractionMethod,
      excerpt: pkbEvidence.excerpt,
      /** What the value is of, as a person reads it (D-128): the attribute, or the identifier type. */
      attributeLabel: sql<string | null>`coalesce(${pkbAttributeDefinitions.label}, upper(${pkbClaims.identifierType}))`,
      sourceUrl: pkbSources.url,
    })
    .from(pkbClaims)
    .innerJoin(pkbEvidence, eq(pkbEvidence.id, pkbClaims.evidenceId))
    .innerJoin(pkbSources, eq(pkbSources.id, pkbEvidence.sourceId))
    .leftJoin(pkbAttributeDefinitions, eq(pkbAttributeDefinitions.id, pkbClaims.definitionId))
    .where(eq(pkbClaims.pkbProductId, pkbProductId))
    .orderBy(sql`${pkbClaims.createdAt} desc`);
}
