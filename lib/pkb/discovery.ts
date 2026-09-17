import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  pkbAttributeDefinitions,
  pkbAttributeProposals,
  pkbEvidence,
  pkbFamilies,
  pkbLegacyAttributeMap,
  pkbProducts,
  pkbSources,
  type PkbLabelContext,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createCategoryAttributeIn } from "@/lib/catalog/category-attributes";
import { PkbError, queryRows, type Executor } from "./common";
import { addAttributeToFamily } from "./families";
import { recordLabelMapping } from "./mappings";
import { keyFromLabel, labelKey, type AttributeDataType } from "./normalize";
import { createClaim } from "./review";
import { findUnit, parseNumberText } from "./units";
import { freeDefinitionKey, loadDefinitions } from "./vocabulary";

/**
 * Attribute discovery (D-073).
 *
 * Extraction finds labels no attribute names. Nothing is invented from them:
 * the label, one example value and the evidence behind it are recorded as a
 * proposal, and a person decides what it is. Three answers are possible.
 *
 *  - Add to Family — the attribute belongs to this kind of product, so it
 *    joins the family's schema and is asked of every product in it.
 *  - Product only — a real attribute of this product that the family should
 *    not ask for; the attribute is defined, but the family is untouched.
 *  - Ignore — not an attribute (marketing copy, a duplicate of a heading).
 *
 * Every answer is remembered as a reusable label mapping, so the next product
 * carrying the same label is placed without asking again (A-8). An accepted
 * proposal creates a claim from its evidence; the value itself still goes
 * through review before it becomes a fact.
 */

// ------------------------------------------------------------------ shape

export type ProposedShape = {
  dataType: AttributeDataType;
  cardinality: "single" | "multiple";
  unitDimension: string | null;
  displayUnit: string | null;
};

/**
 * A first guess at what kind of value a label holds, from one example. It is
 * only a default on the review screen: a person confirms or changes it, and
 * nothing is stored as fact on the strength of the guess.
 */
export function guessShape(value: string, unitHint: string | null): ProposedShape {
  const text = value.trim();
  const unit = unitHint ? findUnit(unitHint) : undefined;
  if (unit) return { dataType: "quantity", cardinality: "single", unitDimension: unit.dimension, displayUnit: unit.code };

  if (/^(yes|no|true|false)$/i.test(text)) {
    return { dataType: "boolean", cardinality: "single", unitDimension: null, displayUnit: null };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { dataType: "date", cardinality: "single", unitDimension: null, displayUnit: null };
  }
  if (/^https?:\/\//i.test(text)) {
    return { dataType: "url", cardinality: "single", unitDimension: null, displayUnit: null };
  }
  const embedded = /^[-+]?[\d.,]+\s*([^\s\d].*)$/.exec(text);
  if (embedded) {
    const found = findUnit(embedded[1].trim());
    if (found && parseNumberText(text.slice(0, embedded.index + embedded[0].length - embedded[1].length)) !== null) {
      return { dataType: "quantity", cardinality: "single", unitDimension: found.dimension, displayUnit: found.code };
    }
  }
  if (parseNumberText(text) !== null) {
    return { dataType: "number", cardinality: "single", unitDimension: null, displayUnit: null };
  }
  return { dataType: "text", cardinality: "single", unitDimension: null, displayUnit: null };
}

// -------------------------------------------------------------- proposing

export type AttributeProposalInput = {
  pkbProductId: string;
  label: string;
  exampleValue: string;
  evidenceId: string;
  unitHint?: string | null;
  shape?: Partial<ProposedShape>;
};

/**
 * Records one discovered label, inside the caller's transaction. Repeats are
 * folded into the open proposal, so one run does not fill the queue with the
 * same label. Internal: the caller checks permission.
 */
export async function proposeAttribute(
  tx: Executor,
  input: AttributeProposalInput,
): Promise<{ proposalId: string; created: boolean }> {
  const label = input.label.trim();
  const normalized = labelKey(label);
  if (!normalized) throw new PkbError("A proposal needs the label as written.");
  const value = input.exampleValue.trim();
  if (!value) throw new PkbError("A proposal needs the value as written.");

  const [open] = await tx
    .select({ id: pkbAttributeProposals.id })
    .from(pkbAttributeProposals)
    .where(
      and(
        eq(pkbAttributeProposals.pkbProductId, input.pkbProductId),
        eq(pkbAttributeProposals.labelNormalized, normalized),
        eq(pkbAttributeProposals.status, "open"),
      ),
    );
  if (open) return { proposalId: open.id, created: false };

  const guessed = guessShape(value, input.unitHint ?? null);
  const shape: ProposedShape = { ...guessed, ...input.shape };
  const [created] = await tx
    .insert(pkbAttributeProposals)
    .values({
      pkbProductId: input.pkbProductId,
      label,
      labelNormalized: normalized,
      exampleValue: value,
      dataType: shape.dataType,
      cardinality: shape.cardinality,
      unitDimension: shape.unitDimension,
      displayUnit: shape.displayUnit,
      evidenceId: input.evidenceId,
    })
    .returning({ id: pkbAttributeProposals.id });
  return { proposalId: created.id, created: true };
}

// ---------------------------------------------------------------- reading

export type AttributeProposalView = {
  id: string;
  label: string;
  exampleValue: string;
  dataType: string;
  cardinality: "single" | "multiple";
  unitDimension: string | null;
  displayUnit: string | null;
  status: "open" | "added_to_family" | "product_only" | "ignored";
  evidenceId: string;
  evidenceExcerpt: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  definitionId: string | null;
  createdAt: Date;
};

export async function listAttributeProposals(
  executor: Executor,
  pkbProductId: string,
  options: { status?: "open" | "all" } = {},
): Promise<AttributeProposalView[]> {
  const rows = await executor
    .select({
      id: pkbAttributeProposals.id,
      label: pkbAttributeProposals.label,
      exampleValue: pkbAttributeProposals.exampleValue,
      dataType: pkbAttributeProposals.dataType,
      cardinality: pkbAttributeProposals.cardinality,
      unitDimension: pkbAttributeProposals.unitDimension,
      displayUnit: pkbAttributeProposals.displayUnit,
      status: pkbAttributeProposals.status,
      evidenceId: pkbAttributeProposals.evidenceId,
      evidenceExcerpt: pkbEvidence.excerpt,
      sourceTitle: pkbSources.title,
      sourceUrl: pkbSources.url,
      definitionId: pkbAttributeProposals.definitionId,
      createdAt: pkbAttributeProposals.createdAt,
    })
    .from(pkbAttributeProposals)
    .innerJoin(pkbEvidence, eq(pkbEvidence.id, pkbAttributeProposals.evidenceId))
    .leftJoin(pkbSources, eq(pkbSources.id, pkbEvidence.sourceId))
    .where(
      options.status === "all"
        ? eq(pkbAttributeProposals.pkbProductId, pkbProductId)
        : and(eq(pkbAttributeProposals.pkbProductId, pkbProductId), eq(pkbAttributeProposals.status, "open")),
    )
    .orderBy(desc(pkbAttributeProposals.createdAt));
  return rows as AttributeProposalView[];
}

// --------------------------------------------------------------- deciding

export type ProposalDecision = {
  action: "add_to_family" | "product_only" | "ignore";
  /** An existing attribute this label means, instead of defining a new one. */
  definitionId?: string | null;
  /** Overrides of the guessed shape, when a new attribute is defined. */
  shape?: Partial<ProposedShape>;
  label?: string;
  note?: string | null;
  /** Where the label was written; a mapping is remembered for that context. */
  context?: PkbLabelContext;
  searchable?: boolean;
  filterable?: boolean;
  seoRelevant?: boolean;
  requirement?: "required" | "recommended" | "optional";
};

const LEGACY_DATA_TYPE: Record<AttributeDataType, string> = {
  text: "text",
  number: "number",
  quantity: "measurement",
  quantity_range: "text",
  boolean: "boolean",
  enum: "select",
  date: "date",
  url: "url",
  brand: "text",
};

/**
 * Settles one proposal. Defining the attribute, extending the family or the
 * category, remembering the label and proposing the value all happen in one
 * transaction, so a half-accepted proposal cannot exist.
 */
export async function decideAttributeProposal(
  actor: SessionUser | null,
  proposalId: string,
  decision: ProposalDecision,
): Promise<{ status: string; definitionId: string | null; claimId: string | null; versionId: string | null }> {
  const staff = requirePermission(actor, "knowledge.manage");

  return db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(pkbAttributeProposals).where(eq(pkbAttributeProposals.id, proposalId)).for("update");
    if (!proposal) throw new PkbError("That proposal does not exist.", 404);
    if (proposal.status !== "open") throw new PkbError("That proposal has already been decided.", 409);

    const [product] = await tx
      .select({ id: pkbProducts.id, familyId: pkbProducts.familyId })
      .from(pkbProducts)
      .where(eq(pkbProducts.id, proposal.pkbProductId));
    if (!product) throw new PkbError("That product is not in the knowledge base.", 404);

    const label = (decision.label ?? proposal.label).trim();
    const context: PkbLabelContext = decision.context ?? "source_document";
    const now = new Date();

    if (decision.action === "ignore") {
      await recordLabelMapping(tx, staff.id, { label, context, action: "ignore", note: decision.note ?? null });
      await tx
        .update(pkbAttributeProposals)
        .set({ status: "ignored", decidedBy: staff.id, decidedAt: now })
        .where(eq(pkbAttributeProposals.id, proposalId));
      await recordAudit(
        {
          actorUserId: staff.id,
          action: "knowledge.proposal_decided",
          entityType: "pkb_attribute_proposal",
          entityId: proposalId,
          after: { action: "ignore", label, context },
        },
        tx,
      );
      return { status: "ignored", definitionId: null, claimId: null, versionId: null };
    }

    const shape: ProposedShape = {
      dataType: proposal.dataType as AttributeDataType,
      cardinality: proposal.cardinality,
      unitDimension: proposal.unitDimension,
      displayUnit: proposal.displayUnit,
      ...decision.shape,
    };

    let definitionId = decision.definitionId ?? null;
    let versionId: string | null = null;

    // A family mirrored from a category takes the attribute through the
    // category, so the mirror keeps it on the next pass instead of dropping a
    // version added behind its back.
    const family = product.familyId
      ? (
          await tx
            .select({ id: pkbFamilies.id, status: pkbFamilies.status, legacyCategoryId: pkbFamilies.legacyCategoryId })
            .from(pkbFamilies)
            .where(eq(pkbFamilies.id, product.familyId))
        )[0]
      : undefined;

    if (decision.action === "add_to_family") {
      if (!family) throw new PkbError("Assign the product to a family before adding an attribute to it.", 409);
      if (family.legacyCategoryId) {
        if (definitionId) {
          throw new PkbError(
            "This family mirrors a category's specifications. Add the specification to the category, which defines its own attribute.",
            409,
          );
        }
        const [category] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.id, family.legacyCategoryId));
        if (!category) throw new PkbError("That family's category no longer exists.", 409);
        const created = await createCategoryAttributeIn(tx, staff.id, category.id, {
          name: label,
          dataType: LEGACY_DATA_TYPE[shape.dataType] as never,
          unit: shape.displayUnit ?? null,
          options: shape.dataType === "enum" ? [proposal.exampleValue] : null,
          isRequired: decision.requirement === "required",
          isFilterable: decision.filterable ?? undefined,
          isSearchable: decision.searchable ?? undefined,
        } as never);
        const [mapped] = await tx
          .select({ definitionId: pkbLegacyAttributeMap.definitionId })
          .from(pkbLegacyAttributeMap)
          .where(eq(pkbLegacyAttributeMap.categoryAttributeId, created.id));
        if (!mapped) throw new PkbError("The category's family schema did not pick up the new specification.", 500);
        definitionId = mapped.definitionId;
      }
    }

    if (!definitionId) {
      definitionId = await defineAttribute(tx, staff.id, label, shape, decision, now);
    }

    if (decision.action === "add_to_family" && family && !family.legacyCategoryId) {
      const added = await addAttributeToFamily(
        tx,
        staff.id,
        family.id,
        {
          definitionId,
          requirement: decision.requirement ?? "optional",
          searchable: decision.searchable ?? null,
          filterable: decision.filterable ?? null,
          seoRelevant: decision.seoRelevant ?? null,
        },
        `Discovered attribute "${label}" accepted from a source document.`,
      );
      versionId = added.versionId;
    }

    // Remembered for the next product that writes the same label. Scoped to
    // the family when the decision was about this kind of product.
    await recordLabelMapping(tx, staff.id, {
      label,
      context,
      familyId: decision.action === "add_to_family" ? (family?.id ?? null) : null,
      action: "map",
      definitionId,
      note: decision.note ?? null,
    });

    // The value itself is only a claim: it becomes a fact through review.
    const [definition] = await loadDefinitions(tx, [definitionId]);
    if (!definition) throw new PkbError("That attribute does not exist.", 404);
    const claim = await createClaim(tx, {
      pkbProductId: product.id,
      pkbVariantId: null,
      evidenceId: proposal.evidenceId,
      proposedBy: staff.id,
      proposedByRun: null,
      target: "fact",
      definition,
      raw: proposal.exampleValue,
      unit: shape.displayUnit,
    });

    const status = decision.action === "add_to_family" ? "added_to_family" : "product_only";
    await tx
      .update(pkbAttributeProposals)
      .set({
        status,
        familyId: decision.action === "add_to_family" ? (family?.id ?? null) : null,
        definitionId,
        claimId: claim.id,
        decidedBy: staff.id,
        decidedAt: now,
      })
      .where(eq(pkbAttributeProposals.id, proposalId));

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.proposal_decided",
        entityType: "pkb_attribute_proposal",
        entityId: proposalId,
        after: { action: decision.action, label, definitionId, claimId: claim.id, versionId },
      },
      tx,
    );
    return { status, definitionId, claimId: claim.id, versionId };
  });
}

/** Defines the attribute a proposal describes, approved by the person deciding. */
async function defineAttribute(
  tx: Executor,
  staffId: string,
  label: string,
  shape: ProposedShape,
  decision: ProposalDecision,
  now: Date,
): Promise<string> {
  const key = await freeDefinitionKey(tx, keyFromLabel(label));
  const [created] = await tx
    .insert(pkbAttributeDefinitions)
    .values({
      key,
      label,
      dataType: shape.dataType,
      cardinality: shape.cardinality,
      unitDimension: shape.unitDimension,
      displayUnit: shape.displayUnit,
      searchable: decision.searchable ?? true,
      filterable: decision.filterable ?? false,
      seoRelevant: decision.seoRelevant ?? false,
      status: "approved",
      origin: "MANUAL_ADMIN",
      createdBy: staffId,
      decidedBy: staffId,
      decidedAt: now,
    })
    .returning({ id: pkbAttributeDefinitions.id });
  await recordAudit(
    {
      actorUserId: staffId,
      action: "knowledge.definition_created",
      entityType: "pkb_attribute_definition",
      entityId: created.id,
      after: { key, label, dataType: shape.dataType, from: "attribute_discovery" },
    },
    tx,
  );
  return created.id;
}

/** How many labels are waiting for a person, per listing — for the admin lists. */
export async function openProposalCounts(executor: Executor, listingIds: string[]): Promise<Map<string, number>> {
  if (listingIds.length === 0) return new Map();
  const rows = await queryRows<{ product_id: string; open: number }>(
    executor,
    sql`
      select p.id as product_id, count(*)::int as open
      from pkb_attribute_proposals pr
      join products p on p.pkb_product_id = pr.pkb_product_id
      where pr.status = 'open' and p.id = any(${`{${listingIds.join(",")}}`}::uuid[])
      group by 1
    `,
  );
  return new Map(rows.map((row) => [row.product_id, row.open]));
}
