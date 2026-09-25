import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  pkbClaims,
  pkbEvidence,
  pkbFacts,
  pkbIdentifiers,
  pkbProducts,
  pkbSources,
  pkbVariants,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { PkbError, PkbLockedError, staffChange, type Executor } from "./common";
import { beginProductChange, finishProductChange, writeDecidedFact } from "./facts";
import { normalizeIdentifier, type IdentifierInputType } from "./identifiers";
import { refreshResolution } from "./resolution";
import {
  createStaffEntrySource,
  ensureBrand,
  insertIdentifier,
  notApplicableValue,
  readValue,
  sameStoredValue,
  updateIdentifier,
  valueColumns,
  type FactRow,
  type FactValue,
  type IdentifierRow,
} from "./store";
import { EMPTY_TYPED } from "./normalize";
import { evaluateVerification } from "./trust";
import { loadDefinitions, type DefinitionRecord } from "./vocabulary";

/**
 * The review half of the pipeline (D-076): PROPOSE → ADMIN REVIEW → APPLY →
 * HISTORY.
 *
 * Every action names the claims it acts on; there is no "apply everything".
 * Accepting as VERIFIED requires a verification policy to qualify the claim at
 * that moment. A locked value is never replaced; a value staff entered or
 * verified is replaced only with an explicit override. All claims in one
 * action are applied in one transaction or not at all.
 */

type ClaimRow = typeof pkbClaims.$inferSelect;

/** Verification states a person has already decided. */
const DECIDED = new Set<string>(["VERIFIED", "MANUAL"]);

/** A claim's value in the shape facts are written in. */
export function claimValue(claim: ClaimRow): FactValue {
  if (claim.valueStatus === "not_applicable") return notApplicableValue();
  return {
    valueStatus: claim.valueStatus,
    rawValue: claim.rawValue,
    rawUnit: claim.rawUnit,
    rawLabel: null,
    typed: {
      ...EMPTY_TYPED,
      text: claim.valueText,
      number: claim.valueNumber,
      numberMax: claim.valueNumberMax,
      unit: claim.valueUnit,
      boolean: claim.valueBoolean,
      date: claim.valueDate,
      optionId: claim.valueOptionId,
    },
    brandId: claim.valueBrandId,
    failure: null,
  };
}

function sameClaimValue(a: ClaimRow, b: ClaimRow): boolean {
  if (a.targetKind === "identifier") {
    return (a.identifierNormalized ?? a.rawValue) === (b.identifierNormalized ?? b.rawValue);
  }
  return sameStoredValue(a as unknown as FactRow, claimValue(b));
}

function slotCondition(claim: Pick<ClaimRow, "pkbProductId" | "pkbVariantId" | "targetKind" | "definitionId" | "identifierType" | "ordinal">) {
  return and(
    eq(pkbClaims.pkbProductId, claim.pkbProductId),
    claim.pkbVariantId ? eq(pkbClaims.pkbVariantId, claim.pkbVariantId) : isNull(pkbClaims.pkbVariantId),
    claim.targetKind === "fact" ? eq(pkbClaims.definitionId, claim.definitionId!) : eq(pkbClaims.identifierType, claim.identifierType!),
    eq(pkbClaims.ordinal, claim.ordinal),
  );
}

// ------------------------------------------------------------------ proposing

export type NewClaim = {
  pkbProductId: string;
  pkbVariantId: string | null;
  evidenceId: string;
  proposedBy: string | null;
  proposedByRun: string | null;
} & (
  | { target: "fact"; definition: DefinitionRecord; ordinal?: number; raw: string | null; unit?: string | null; notApplicable?: boolean }
  | { target: "identifier"; inputType: IdentifierInputType; raw: string }
);

/**
 * Records a claim: SUGGESTED, or CONFLICT when it disagrees with the accepted
 * value or another open claim (which become CONFLICT too). Never touches a
 * fact or an identifier. Internal: callers check permission.
 */
export async function createClaim(tx: Executor, input: NewClaim): Promise<ClaimRow> {
  let columns: Partial<typeof pkbClaims.$inferInsert>;
  let slot: Pick<ClaimRow, "pkbProductId" | "pkbVariantId" | "targetKind" | "definitionId" | "identifierType" | "ordinal">;
  let disagreesWithAccepted = false;
  /** An accepted value already stands in this slot, and this claim says the same. */
  let repeatsAccepted = false;

  if (input.target === "fact") {
    const ordinal = input.ordinal ?? 0;
    const written = input.unit ? `${input.raw} ${input.unit}` : input.raw ?? "";
    const value = input.notApplicable ? notApplicableValue() : readValue(input.definition, written);
    if (value.valueStatus === "normalized" && value.typed.brandName) {
      value.brandId = await ensureBrand(tx, value.typed.brandName, input.proposedBy ? staffChange(input.proposedBy) : { kind: "legacy" });
      value.typed = { ...value.typed, brandName: null };
    }
    if (!input.notApplicable) {
      value.rawValue = (input.raw ?? "").trim();
      value.rawUnit = input.unit ?? null;
    }
    const { rawLabel: _rawLabel, ...valueFields } = valueColumns(value);
    void _rawLabel;
    columns = { targetKind: "fact", definitionId: input.definition.id, ordinal, ...valueFields };
    slot = { pkbProductId: input.pkbProductId, pkbVariantId: input.pkbVariantId, targetKind: "fact", definitionId: input.definition.id, identifierType: null, ordinal };
    const [fact]: FactRow[] = await tx
      .select()
      .from(pkbFacts)
      .where(
        and(
          eq(pkbFacts.pkbProductId, input.pkbProductId),
          input.pkbVariantId ? eq(pkbFacts.pkbVariantId, input.pkbVariantId) : isNull(pkbFacts.pkbVariantId),
          eq(pkbFacts.definitionId, input.definition.id),
          eq(pkbFacts.ordinal, ordinal),
        ),
      );
    disagreesWithAccepted = fact !== undefined && !sameStoredValue(fact, value);
    // Only a value a person decided: a legacy or unverified one is exactly
    // what a source repeating it may still be accepted to verify.
    repeatsAccepted = fact !== undefined && !disagreesWithAccepted && DECIDED.has(fact.verificationState);
  } else {
    const normalized = normalizeIdentifier(input.inputType, input.raw);
    columns = {
      targetKind: "identifier",
      identifierType: normalized.type,
      ordinal: 0,
      valueStatus: normalized.normalized ? "normalized" : "unnormalized",
      rawValue: normalized.raw,
      identifierNormalized: normalized.normalized,
    };
    slot = { pkbProductId: input.pkbProductId, pkbVariantId: input.pkbVariantId, targetKind: "identifier", definitionId: null, identifierType: normalized.type, ordinal: 0 };
    const existing: IdentifierRow[] = await tx
      .select()
      .from(pkbIdentifiers)
      .where(
        and(
          eq(pkbIdentifiers.pkbProductId, input.pkbProductId),
          input.pkbVariantId ? eq(pkbIdentifiers.pkbVariantId, input.pkbVariantId) : isNull(pkbIdentifiers.pkbVariantId),
          eq(pkbIdentifiers.identifierType, normalized.type),
        ),
      );
    disagreesWithAccepted =
      existing.length > 0 && !existing.some((row) => (row.valueNormalized ?? row.valueRaw) === (normalized.normalized ?? normalized.raw));
    repeatsAccepted =
      !disagreesWithAccepted &&
      existing.some(
        (row) => (row.valueNormalized ?? row.valueRaw) === (normalized.normalized ?? normalized.raw) && DECIDED.has(row.verificationState),
      );
    if (normalized.gtin14) {
      const [owner] = await tx.select({ id: pkbIdentifiers.pkbProductId }).from(pkbIdentifiers).where(eq(pkbIdentifiers.gtin14, normalized.gtin14));
      if (owner && owner.id !== input.pkbProductId) disagreesWithAccepted = true;
    }
  }

  const open: ClaimRow[] = await tx
    .select()
    .from(pkbClaims)
    .where(and(slotCondition(slot), inArray(pkbClaims.status, ["SUGGESTED", "CONFLICT"])));

  const [claim]: ClaimRow[] = await tx
    .insert(pkbClaims)
    .values({
      pkbProductId: input.pkbProductId,
      pkbVariantId: input.pkbVariantId,
      evidenceId: input.evidenceId,
      proposedBy: input.proposedBy,
      proposedByRun: input.proposedByRun,
      status: "SUGGESTED",
      ...columns,
    } as typeof pkbClaims.$inferInsert)
    .returning();

  const disagreeing = open.filter((other) => !sameClaimValue(other, claim));

  /*
   * A source repeating the value a person already accepted (D-122). Reading
   * the manufacturer's page again — which is what preparing a product again
   * does — would otherwise ask somebody to accept every value they had already
   * accepted, and a refresh would never finish on its own. Nothing is decided
   * here: the fact, its verification state and its provenance are untouched,
   * and the claim is kept, with its evidence, as a closed record that the
   * source still says so. A claim that differs is still a CONFLICT, and one
   * that repeats an accepted value while another open claim disagrees is left
   * open for the person deciding that slot.
   */
  if (repeatsAccepted && disagreeing.length === 0) {
    const now = new Date();
    await tx
      .update(pkbClaims)
      .set({
        // Not a decision, so no decision time (pkb_claims_decision_check).
        status: "SUPERSEDED",
        decisionNote: "Repeats the value already accepted for this product.",
        updatedAt: now,
      })
      .where(eq(pkbClaims.id, claim.id));
    claim.status = "SUPERSEDED";
    return claim;
  }

  if (disagreesWithAccepted || disagreeing.length > 0) {
    await tx.update(pkbClaims).set({ status: "CONFLICT", updatedAt: new Date() }).where(eq(pkbClaims.id, claim.id));
    claim.status = "CONFLICT";
  }
  if (disagreeing.length > 0) {
    await tx
      .update(pkbClaims)
      .set({ status: "CONFLICT", updatedAt: new Date() })
      .where(and(inArray(pkbClaims.id, disagreeing.map((row) => row.id)), ne(pkbClaims.status, "CONFLICT")));
  }
  return claim;
}

/** After claims leave a slot, the open ones that no longer disagree go back to SUGGESTED. */
async function recomputeSlot(tx: Executor, sample: ClaimRow) {
  const open: ClaimRow[] = await tx
    .select()
    .from(pkbClaims)
    .where(and(slotCondition(sample), inArray(pkbClaims.status, ["SUGGESTED", "CONFLICT"])));
  if (open.length === 0) return;
  let accepted: { matches: (claim: ClaimRow) => boolean } | null = null;
  if (sample.targetKind === "fact") {
    const [fact]: FactRow[] = await tx
      .select()
      .from(pkbFacts)
      .where(
        and(
          eq(pkbFacts.pkbProductId, sample.pkbProductId),
          sample.pkbVariantId ? eq(pkbFacts.pkbVariantId, sample.pkbVariantId) : isNull(pkbFacts.pkbVariantId),
          eq(pkbFacts.definitionId, sample.definitionId!),
          eq(pkbFacts.ordinal, sample.ordinal),
        ),
      );
    if (fact) accepted = { matches: (claim) => sameStoredValue(fact, claimValue(claim)) };
  } else {
    const rows: IdentifierRow[] = await tx
      .select()
      .from(pkbIdentifiers)
      .where(
        and(
          eq(pkbIdentifiers.pkbProductId, sample.pkbProductId),
          sample.pkbVariantId ? eq(pkbIdentifiers.pkbVariantId, sample.pkbVariantId) : isNull(pkbIdentifiers.pkbVariantId),
          eq(pkbIdentifiers.identifierType, sample.identifierType!),
        ),
      );
    if (rows.length > 0) {
      accepted = { matches: (claim) => rows.some((row) => (row.valueNormalized ?? row.valueRaw) === (claim.identifierNormalized ?? claim.rawValue)) };
    }
  }
  const agreeAmongThemselves = open.every((claim) => sameClaimValue(open[0], claim));
  for (const claim of open) {
    const conflict = !agreeAmongThemselves || (accepted !== null && !accepted.matches(claim));
    const status = conflict ? "CONFLICT" : "SUGGESTED";
    if (claim.status !== status) {
      await tx.update(pkbClaims).set({ status, updatedAt: new Date() }).where(eq(pkbClaims.id, claim.id));
    }
  }
}

// ------------------------------------------------------------------ deciding

type LoadedClaim = {
  claim: ClaimRow;
  source: typeof pkbSources.$inferSelect;
  definition: DefinitionRecord | null;
};

async function loadClaimsForDecision(tx: Executor, claimIds: string[]): Promise<LoadedClaim[]> {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) throw new PkbError("Choose at least one claim.");
  if (unique.length > 100) throw new PkbError("Review at most 100 claims at a time.");
  const rows: { claim: ClaimRow; source: typeof pkbSources.$inferSelect }[] = await tx
    .select({ claim: pkbClaims, source: pkbSources })
    .from(pkbClaims)
    .innerJoin(pkbEvidence, eq(pkbEvidence.id, pkbClaims.evidenceId))
    .innerJoin(pkbSources, eq(pkbSources.id, pkbEvidence.sourceId))
    .where(inArray(pkbClaims.id, unique))
    .orderBy(pkbClaims.id)
    .for("update", { of: pkbClaims });
  if (rows.length !== unique.length) throw new PkbError("One of those claims no longer exists.", 404);
  const products = new Set(rows.map((row) => row.claim.pkbProductId));
  if (products.size !== 1) throw new PkbError("Review one product's claims at a time.");
  const definitions = new Map(
    (await loadDefinitions(tx, [...new Set(rows.map((row) => row.claim.definitionId).filter((id): id is string => Boolean(id)))])).map((row) => [row.id, row]),
  );
  return rows.map((row) => ({ ...row, definition: row.claim.definitionId ? definitions.get(row.claim.definitionId) ?? null : null }));
}

export type AcceptOptions = {
  claimIds: string[];
  /** Accept as VERIFIED: every claim must qualify under an active policy now. */
  asVerified?: boolean;
  /** Replace values staff entered or verified that say something different. */
  overrideDecided?: boolean;
  note?: string | null;
};

export type AcceptResult = { accepted: number; verified: number };

/**
 * Accepts named claims, all or none. Each becomes the slot's value, with its
 * source, evidence and the deciding staff member. Accepted as VERIFIED only
 * under a policy that qualifies it; otherwise UNVERIFIED — accepted, not
 * verified. Claims that say the same thing are accepted with it.
 */
export async function acceptClaims(actor: SessionUser | null, options: AcceptOptions): Promise<AcceptResult> {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const loaded = await loadClaimsForDecision(tx, options.claimIds);
    return applyAcceptance(tx, staff.id, loaded, options, { resolvingConflict: false });
  });
}

async function applyAcceptance(
  tx: Executor,
  actorId: string,
  loaded: LoadedClaim[],
  options: AcceptOptions,
  mode: { resolvingConflict: boolean },
): Promise<AcceptResult> {
  const pkbProductId = loaded[0].claim.pkbProductId;
  const slots = new Set<string>();
  for (const { claim } of loaded) {
    const key = `${claim.pkbVariantId}|${claim.targetKind}|${claim.definitionId ?? claim.identifierType}|${claim.ordinal}`;
    if (slots.has(key)) throw new PkbError("Two of those claims are for the same value. Choose one.");
    slots.add(key);
    if (claim.status === "CONFLICT" && !mode.resolvingConflict) {
      throw new PkbError("A claim in conflict is decided by resolving the conflict, choosing between the claims.", 409);
    }
    if (claim.status !== "SUGGESTED" && claim.status !== "CONFLICT") {
      throw new PkbError(`That claim is already ${claim.status.toLowerCase()}.`, 409);
    }
  }

  const listings = await beginProductChange(tx, pkbProductId);
  const now = new Date();
  let verified = 0;
  let identityChanged = false;

  for (const { claim, source, definition } of loaded) {
    let policyKey: string | null = null;
    if (options.asVerified) {
      if (claim.status !== "SUGGESTED") throw new PkbError("Resolve the conflict before verifying.", 409);
      const qualification = await evaluateVerification(tx, claim.id);
      if (!qualification.eligible || !qualification.policy) {
        throw new PkbError(`Not verifiable: ${qualification.reasons.join(" ")}`, 409, { claimId: claim.id, reasons: qualification.reasons });
      }
      policyKey = qualification.policy.key;
      verified += 1;
    }
    const provenance = {
      verificationState: (policyKey ? "VERIFIED" : "UNVERIFIED") as "VERIFIED" | "UNVERIFIED",
      origin: source.origin,
      sourceId: source.id,
      claimId: claim.id,
      decidedBy: actorId,
      decisionPolicy: policyKey,
    };
    const reason = `${policyKey ? "Verified" : "Accepted"} from ${source.domain ?? source.title ?? source.sourceType}${options.note ? `: ${options.note}` : ""}`;

    if (claim.targetKind === "fact") {
      if (!definition) throw new PkbError("That claim's attribute no longer exists.", 404);
      await writeDecidedFact(tx, {
        pkbProductId,
        pkbVariantId: claim.pkbVariantId,
        definition,
        ordinal: claim.ordinal,
        value: claimValue(claim),
        provenance,
        listings,
        actorId,
        reason,
        overrideDecided: options.overrideDecided,
      });
      if (["brand", "model_name", "generation"].includes(definition.key)) identityChanged = true;
    } else {
      if (claim.valueStatus !== "normalized") throw new PkbError("An invalid identifier cannot be accepted. Reject it, or enter the correct one by hand.", 409);
      const normalized = normalizeIdentifier(claim.identifierType as IdentifierInputType, claim.rawValue!);
      const existing: IdentifierRow[] = await tx
        .select()
        .from(pkbIdentifiers)
        .where(
          and(
            eq(pkbIdentifiers.pkbProductId, pkbProductId),
            claim.pkbVariantId ? eq(pkbIdentifiers.pkbVariantId, claim.pkbVariantId) : isNull(pkbIdentifiers.pkbVariantId),
            eq(pkbIdentifiers.identifierType, normalized.type),
          ),
        );
      const same = existing.find((row) => row.valueNormalized === normalized.normalized);
      const other = existing.find((row) => row.valueNormalized !== normalized.normalized);
      if (normalized.gtin14) {
        const [owner] = await tx.select({ id: pkbIdentifiers.pkbProductId }).from(pkbIdentifiers).where(eq(pkbIdentifiers.gtin14, normalized.gtin14));
        if (owner && owner.id !== pkbProductId) throw new PkbError("That GTIN already belongs to another product. Resolve the product's identity first.", 409);
      }
      const columns = {
        identifierType: normalized.type,
        valueRaw: normalized.raw,
        valueNormalized: normalized.normalized,
        gtin14: normalized.gtin14,
        validationStatus: normalized.validation,
        ...provenance,
      };
      const target = same ?? other;
      if (target?.lockedAt) throw new PkbLockedError("That identifier");
      if (other && !same && !options.overrideDecided && (other.verificationState === "MANUAL" || other.verificationState === "VERIFIED")) {
        throw new PkbError(`The ${normalized.type.toUpperCase()} already has a decided value (${other.valueRaw}). Confirm replacing it.`, 409);
      }
      if (target) {
        await updateIdentifier(tx, target, { ...columns, legacyRef: target.legacyRef }, { actorId, reason });
      } else {
        await insertIdentifier(tx, { pkbProductId, pkbVariantId: claim.pkbVariantId, ...columns, legacyRef: null }, { actorId, reason });
      }
      identityChanged = true;
    }

    await tx
      .update(pkbClaims)
      .set({ status: "ACCEPTED", decidedBy: actorId, decidedAt: now, decisionPolicy: policyKey, decisionNote: options.note ?? null, updatedAt: now })
      .where(eq(pkbClaims.id, claim.id));
    // Claims that say the same thing are corroboration, accepted with it.
    const agreeing: ClaimRow[] = await tx
      .select()
      .from(pkbClaims)
      .where(and(slotCondition(claim), inArray(pkbClaims.status, ["SUGGESTED", "CONFLICT"]), ne(pkbClaims.id, claim.id)));
    const corroborating = agreeing.filter((other) => sameClaimValue(other, claim)).map((other) => other.id);
    if (corroborating.length > 0) {
      await tx
        .update(pkbClaims)
        .set({ status: "ACCEPTED", decidedBy: actorId, decidedAt: now, decisionNote: "Says the same as the accepted claim.", updatedAt: now })
        .where(inArray(pkbClaims.id, corroborating));
    }
    await recomputeSlot(tx, claim);
  }

  if (identityChanged) await refreshResolution(tx, pkbProductId);
  await recordAudit(
    {
      actorUserId: actorId,
      action: "knowledge.claims_accepted",
      entityType: "pkb_product",
      entityId: pkbProductId,
      after: { claims: loaded.map(({ claim }) => claim.id), verified, note: options.note ?? null },
    },
    tx,
  );
  await finishProductChange(tx, actorId, listings, pkbProductId);
  return { accepted: loaded.length, verified };
}

/** Rejects named claims. The evidence stays on record; the value is not used. */
export async function rejectClaims(actor: SessionUser | null, claimIds: string[], note?: string | null): Promise<number> {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const loaded = await loadClaimsForDecision(tx, claimIds);
    const now = new Date();
    for (const { claim } of loaded) {
      if (claim.status !== "SUGGESTED" && claim.status !== "CONFLICT") {
        throw new PkbError(`That claim is already ${claim.status.toLowerCase()}.`, 409);
      }
    }
    await tx
      .update(pkbClaims)
      .set({ status: "REJECTED", decidedBy: staff.id, decidedAt: now, decisionNote: note ?? null, updatedAt: now })
      .where(inArray(pkbClaims.id, loaded.map(({ claim }) => claim.id)));
    for (const { claim } of loaded) await recomputeSlot(tx, claim);
    if (loaded.some(({ claim }) => claim.targetKind === "identifier")) await refreshResolution(tx, loaded[0].claim.pkbProductId);
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.claims_rejected", entityType: "pkb_product", entityId: loaded[0].claim.pkbProductId, after: { claims: claimIds, note: note ?? null } },
      tx,
    );
    return loaded.length;
  });
}

/**
 * Resolves a conflict: the chosen claim is accepted and every other open
 * claim for that value is rejected — or, with no chosen claim, the current
 * value is kept and every open claim rejected.
 */
export async function resolveConflict(
  actor: SessionUser | null,
  input: { claimId: string; keepCurrent?: boolean; overrideDecided?: boolean; note?: string | null },
) {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const [anchor] = await loadClaimsForDecision(tx, [input.claimId]);
    const open: ClaimRow[] = await tx
      .select()
      .from(pkbClaims)
      .where(and(slotCondition(anchor.claim), inArray(pkbClaims.status, ["SUGGESTED", "CONFLICT"])))
      .orderBy(pkbClaims.id)
      .for("update");
    const now = new Date();
    const rejectIds = open.filter((claim) => input.keepCurrent || claim.id !== anchor.claim.id).map((claim) => claim.id);
    const note = input.note ?? (input.keepCurrent ? "Conflict resolved by keeping the current value." : "Conflict resolved in favour of another claim.");

    let result: AcceptResult = { accepted: 0, verified: 0 };
    if (!input.keepCurrent) {
      if (!open.some((claim) => claim.id === anchor.claim.id)) throw new PkbError("That claim is no longer open.", 409);
      result = await applyAcceptance(tx, staff.id, [anchor], { claimIds: [anchor.claim.id], overrideDecided: input.overrideDecided, note }, { resolvingConflict: true });
    }
    const stillOpen = rejectIds.length
      ? await tx.select({ id: pkbClaims.id }).from(pkbClaims).where(and(inArray(pkbClaims.id, rejectIds), inArray(pkbClaims.status, ["SUGGESTED", "CONFLICT"])))
      : [];
    if (stillOpen.length > 0) {
      await tx
        .update(pkbClaims)
        .set({ status: "REJECTED", decidedBy: staff.id, decidedAt: now, decisionNote: note, updatedAt: now })
        .where(inArray(pkbClaims.id, stillOpen.map((row: { id: string }) => row.id)));
    }
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.claims_rejected", entityType: "pkb_product", entityId: anchor.claim.pkbProductId, after: { resolvedConflict: true, kept: input.keepCurrent ?? false, rejected: stillOpen.length } },
      tx,
    );
    if (anchor.claim.targetKind === "identifier") await refreshResolution(tx, anchor.claim.pkbProductId);
    return { ...result, rejected: stillOpen.length };
  });
}

/**
 * Staff correct a proposed value: the claim is rejected (the source said
 * something else) and the corrected value is entered as MANUAL.
 */
export async function correctClaim(actor: SessionUser | null, claimId: string, raw: string, note?: string | null) {
  const staff = requirePermission(actor, "catalog.manage");
  const value = raw.trim();
  if (!value) throw new PkbError("Enter the corrected value.");
  return db.transaction(async (tx) => {
    const [{ claim, definition }] = await loadClaimsForDecision(tx, [claimId]);
    if (claim.targetKind !== "fact" || !definition) throw new PkbError("Correct an identifier by entering it by hand.", 409);
    if (claim.status !== "SUGGESTED" && claim.status !== "CONFLICT") throw new PkbError(`That claim is already ${claim.status.toLowerCase()}.`, 409);
    const listings = await beginProductChange(tx, claim.pkbProductId);
    const factValue = readValue(definition, value);
    if (factValue.valueStatus === "normalized" && factValue.typed.brandName) {
      factValue.brandId = await ensureBrand(tx, factValue.typed.brandName, staffChange(staff.id));
      factValue.typed = { ...factValue.typed, brandName: null };
    }
    const sourceId = await createStaffEntrySource(tx, staff.id, "Corrected during review");
    await writeDecidedFact(tx, {
      pkbProductId: claim.pkbProductId,
      pkbVariantId: claim.pkbVariantId,
      definition,
      ordinal: claim.ordinal,
      value: factValue,
      provenance: { verificationState: "MANUAL", origin: "MANUAL_ADMIN", sourceId, claimId: null, decidedBy: staff.id, decisionPolicy: null },
      listings,
      actorId: staff.id,
      reason: `Corrected during review${note ? `: ${note}` : ""}`,
      overrideDecided: true,
    });
    const now = new Date();
    await tx
      .update(pkbClaims)
      .set({ status: "REJECTED", decidedBy: staff.id, decidedAt: now, decisionNote: `Corrected by staff to "${value}".`, updatedAt: now })
      .where(eq(pkbClaims.id, claim.id));
    await recomputeSlot(tx, claim);
    await finishProductChange(tx, staff.id, listings, claim.pkbProductId);
    // The caller is an HTTP route, so this returns a result rather than
    // nothing: `NextResponse.json(undefined)` is a 500, not an empty body.
    return { claimId: claim.id, status: "REJECTED" as const, value };
  });
}

/** Locks or unlocks an identifier. Locked identifiers are never replaced automatically. */
export async function setIdentifierLock(actor: SessionUser | null, identifierId: string, lock: boolean) {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(pkbIdentifiers).where(eq(pkbIdentifiers.id, identifierId));
    if (!row) throw new PkbError("That identifier no longer exists.", 404);
    await beginProductChange(tx, row.pkbProductId);
    if (Boolean(row.lockedAt) === lock) return row;
    return updateIdentifier(
      tx,
      row,
      lock ? { lockedAt: new Date(), lockedBy: staff.id } : { lockedAt: null, lockedBy: null },
      { actorId: staff.id, reason: lock ? "Locked." : "Unlocked.", kind: lock ? "locked" : "unlocked" },
    );
  });
}

/** Proposes a value from evidence staff recorded — the manual "Add source" path. */
export async function proposeClaimFromEvidence(
  actor: SessionUser | null,
  input: { pkbProductId: string; pkbVariantId?: string | null; evidenceId: string } & (
    | { target: "fact"; definitionId: string; ordinal?: number; raw?: string; unit?: string | null; notApplicable?: boolean }
    | { target: "identifier"; inputType: IdentifierInputType; raw: string }
  ),
) {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: pkbProducts.id }).from(pkbProducts).where(eq(pkbProducts.id, input.pkbProductId));
    if (!product) throw new PkbError("That product is not in the knowledge base.", 404);
    if (input.pkbVariantId) {
      const [variant] = await tx
        .select({ id: pkbVariants.id })
        .from(pkbVariants)
        .where(and(eq(pkbVariants.id, input.pkbVariantId), eq(pkbVariants.pkbProductId, product.id)));
      if (!variant) throw new PkbError("That variant does not belong to this product.", 404);
    }
    const [evidence] = await tx.select().from(pkbEvidence).where(eq(pkbEvidence.id, input.evidenceId));
    if (!evidence || evidence.pkbProductId !== product.id) throw new PkbError("A claim needs evidence recorded for the same product.", 400);

    let claim: ClaimRow;
    if (input.target === "fact") {
      const [definition] = await loadDefinitions(tx, [input.definitionId]);
      if (!definition) throw new PkbError("That attribute does not exist.", 404);
      if (!input.notApplicable && !input.raw?.trim()) throw new PkbError("A claim needs a value.");
      claim = await createClaim(tx, {
        pkbProductId: product.id,
        pkbVariantId: input.pkbVariantId ?? null,
        evidenceId: evidence.id,
        proposedBy: staff.id,
        proposedByRun: null,
        target: "fact",
        definition,
        ordinal: input.ordinal,
        raw: input.raw ?? null,
        unit: input.unit,
        notApplicable: input.notApplicable,
      });
    } else {
      claim = await createClaim(tx, {
        pkbProductId: product.id,
        pkbVariantId: input.pkbVariantId ?? null,
        evidenceId: evidence.id,
        proposedBy: staff.id,
        proposedByRun: null,
        target: "identifier",
        inputType: input.inputType,
        raw: input.raw,
      });
    }
    await recordAudit(
      { actorUserId: staff.id, action: "knowledge.claim_proposed", entityType: "pkb_product", entityId: product.id, after: { claimId: claim.id, status: claim.status } },
      tx,
    );
    return claim;
  });
}
