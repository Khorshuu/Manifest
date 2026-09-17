import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  pkbAttributeDefinitions,
  pkbFamilies,
  pkbLabelMappings,
  pkbSyncQueue,
  type PkbLabelContext,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { PkbError, queryRows, type Executor } from "./common";
import { labelKey } from "./normalize";
import { matchDefinitionByLabel, type DefinitionRecord } from "./vocabulary";

/**
 * Reviewed label mappings (A-8, D-072).
 *
 * A written label becomes an attribute by exact match only. Anything else
 * waits in `pkb_unmapped_values` for a person, who either maps the label to an
 * attribute or marks it ignored. That decision is stored, so every later row
 * carrying the same label is placed deterministically, without fuzzy matching
 * ever attaching a value to the wrong attribute.
 *
 * A mapping is scoped to a context (where the label was written) and
 * optionally to one Product Family. A label written in a `details` entry is
 * recorded under the `any` context: such keys are free text that means the
 * same wherever it appears, and no narrower context exists for them.
 *
 * Labels are compared by `labelKey`, the same normalization the rest of the
 * knowledge base uses. It is not expressible in SQL, so the queries here read
 * the candidate rows and group them in TypeScript; the open queue is small by
 * design, since every row in it is waiting for a person.
 */

// --------------------------------------------------------------- the index

export type LabelMappingRow = {
  id: string;
  label: string;
  labelNormalized: string;
  context: PkbLabelContext;
  familyId: string | null;
  action: "map" | "ignore";
  definitionId: string | null;
  note: string | null;
};

export type LabelMappingIndex = { byKey: Map<string, LabelMappingRow> };

function indexKey(context: PkbLabelContext, familyId: string | null, labelNormalized: string): string {
  return `${context}|${familyId ?? "*"}|${labelNormalized}`;
}

/** The approved mappings, ready for repeated lookups during one sync pass. */
export async function loadLabelMappings(executor: Executor): Promise<LabelMappingIndex> {
  const rows: LabelMappingRow[] = await executor
    .select({
      id: pkbLabelMappings.id,
      label: pkbLabelMappings.label,
      labelNormalized: pkbLabelMappings.labelNormalized,
      context: pkbLabelMappings.context,
      familyId: pkbLabelMappings.familyId,
      action: pkbLabelMappings.action,
      definitionId: pkbLabelMappings.definitionId,
      note: pkbLabelMappings.note,
    })
    .from(pkbLabelMappings)
    .where(eq(pkbLabelMappings.status, "approved"));
  const byKey = new Map<string, LabelMappingRow>();
  for (const row of rows) byKey.set(indexKey(row.context, row.familyId, row.labelNormalized), row);
  return { byKey };
}

export const EMPTY_LABEL_MAPPINGS: LabelMappingIndex = { byKey: new Map() };

/**
 * The decision that covers this label, most specific first: this family in
 * this context, this family anywhere, any family in this context, any family
 * anywhere.
 */
export function findLabelMapping(
  index: LabelMappingIndex,
  label: string,
  context: PkbLabelContext,
  familyId: string | null,
): LabelMappingRow | undefined {
  const key = labelKey(label);
  if (!key) return undefined;
  const scopes: [PkbLabelContext, string | null][] = [];
  if (familyId) scopes.push([context, familyId]);
  if (familyId && context !== "any") scopes.push(["any", familyId]);
  scopes.push([context, null]);
  if (context !== "any") scopes.push(["any", null]);
  for (const [scopeContext, scopeFamily] of scopes) {
    const found = index.byKey.get(indexKey(scopeContext, scopeFamily, key));
    if (found) return found;
  }
  return undefined;
}

export type LabelResolution =
  | { kind: "match"; definition: DefinitionRecord; viaMapping: boolean }
  | { kind: "ignored"; mappingId: string }
  | { kind: "none" }
  | { kind: "ambiguous" };

/**
 * Places one written label. An approved mapping decides; with none, the exact
 * label match decides; otherwise the row goes to a person.
 */
export function resolveLabel(
  definitions: DefinitionRecord[],
  index: LabelMappingIndex,
  label: string,
  context: PkbLabelContext,
  familyId: string | null,
): LabelResolution {
  const mapping = findLabelMapping(index, label, context, familyId);
  if (mapping) {
    if (mapping.action === "ignore") return { kind: "ignored", mappingId: mapping.id };
    const definition = definitions.find((entry) => entry.id === mapping.definitionId);
    // A mapping whose attribute was retired stops applying rather than
    // writing into a retired slot; the row waits for a person again.
    if (definition && definition.status === "approved") return { kind: "match", definition, viaMapping: true };
    return { kind: "none" };
  }
  const match = matchDefinitionByLabel(definitions, label);
  if (match.kind === "match") return { kind: "match", definition: match.definition, viaMapping: false };
  return match;
}

// ------------------------------------------------------- the review queue

/** Which context a queued row's legacy reference belongs to, or null if the row is not label-based. */
export function contextForLegacyRef(legacyRef: string): PkbLabelContext | null {
  if (legacyRef === "products.spec_table") return "spec_table";
  if (legacyRef === "products.measurements") return "measurements";
  if (legacyRef.startsWith("variant_option_values.")) return "variant_option";
  if (legacyRef.startsWith("products.details.")) return "any";
  return null;
}

/** The reasons a person can settle by mapping the label. */
export const MAPPABLE_REASONS = ["no_matching_definition", "ambiguous_label", "option_without_definition"] as const;

export type UnmappedLabelGroup = {
  label: string;
  labelNormalized: string;
  context: PkbLabelContext;
  familyId: string | null;
  familyName: string | null;
  reasons: string[];
  rows: number;
  listings: number;
  samples: { productId: string; title: string; value: string }[];
};

type QueuedRow = {
  product_id: string;
  title: string;
  label: string;
  value: string;
  reason: string;
  legacy_ref: string;
  family_id: string | null;
  family_name: string | null;
};

/**
 * The unmatched labels, one group per label, context and family, with
 * examples. This is the screen a person works through; nothing is repaired in
 * the database by hand.
 */
export async function listUnmappedLabels(
  executor: Executor,
  options: { familyId?: string | null; limit?: number } = {},
): Promise<UnmappedLabelGroup[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const familyFilter =
    options.familyId === undefined
      ? sql``
      : options.familyId === null
        ? sql`and kp.family_id is null`
        : sql`and kp.family_id = ${options.familyId}`;
  const rows = await queryRows<QueuedRow>(
    executor,
    sql`
      select u.product_id, p.title, u.label, u.value, u.reason, u.legacy_ref,
             kp.family_id, f.name as family_name
      from pkb_unmapped_values u
      join products p on p.id = u.product_id
      left join pkb_products kp on kp.id = p.pkb_product_id
      left join pkb_families f on f.id = kp.family_id
      where u.status = 'open'
        and u.label is not null
        and u.reason in ('no_matching_definition', 'ambiguous_label', 'option_without_definition')
        ${familyFilter}
      order by p.title asc
      limit 5000
    `,
  );

  const groups = new Map<string, UnmappedLabelGroup & { listingIds: Set<string>; reasonSet: Set<string> }>();
  for (const row of rows) {
    const context = contextForLegacyRef(row.legacy_ref);
    if (!context) continue;
    const normalized = labelKey(row.label);
    if (!normalized) continue;
    const key = indexKey(context, row.family_id, normalized);
    let group = groups.get(key);
    if (!group) {
      group = {
        label: row.label,
        labelNormalized: normalized,
        context,
        familyId: row.family_id,
        familyName: row.family_name,
        reasons: [],
        rows: 0,
        listings: 0,
        samples: [],
        listingIds: new Set(),
        reasonSet: new Set(),
      };
      groups.set(key, group);
    }
    group.rows += 1;
    group.listingIds.add(row.product_id);
    group.reasonSet.add(row.reason);
    if (group.samples.length < 3) group.samples.push({ productId: row.product_id, title: row.title, value: row.value });
  }

  return [...groups.values()]
    .map((group) => ({
      label: group.label,
      labelNormalized: group.labelNormalized,
      context: group.context,
      familyId: group.familyId,
      familyName: group.familyName,
      reasons: [...group.reasonSet].sort(),
      rows: group.rows,
      listings: group.listingIds.size,
      samples: group.samples,
    }))
    .sort((a, b) => b.rows - a.rows || a.labelNormalized.localeCompare(b.labelNormalized))
    .slice(0, limit);
}

// ---------------------------------------------------------- the decision

export type LabelMappingDecision = {
  label: string;
  context: PkbLabelContext;
  familyId?: string | null;
  action: "map" | "ignore";
  definitionId?: string | null;
  note?: string | null;
};

/**
 * Records one reviewed mapping and queues every listing it touches for a
 * re-sync, so the waiting rows are placed by the normal pipeline instead of
 * being edited in place.
 */
export async function decideLabelMapping(
  actor: SessionUser | null,
  input: LabelMappingDecision,
): Promise<{ mappingId: string; listingsQueued: number }> {
  const staff = requirePermission(actor, "knowledge.manage");
  return db.transaction(async (tx) => recordLabelMapping(tx, staff.id, input));
}

/**
 * The same decision inside the caller's transaction. Attribute discovery uses
 * it so that approving a proposal and remembering its label are one write.
 * Internal: the caller checks permission.
 */
export async function recordLabelMapping(
  tx: Executor,
  staffId: string,
  input: LabelMappingDecision,
): Promise<{ mappingId: string; listingsQueued: number }> {
  const staff = { id: staffId };
  const label = input.label.trim();
  const normalized = labelKey(label);
  if (!normalized) throw new PkbError("Name the label being mapped.");
  const familyId = input.familyId ?? null;

  {
    let definitionId: string | null = null;
    if (input.action === "map") {
      if (!input.definitionId) throw new PkbError("Choose the attribute this label means.");
      const [definition] = await tx
        .select({ id: pkbAttributeDefinitions.id, status: pkbAttributeDefinitions.status, label: pkbAttributeDefinitions.label })
        .from(pkbAttributeDefinitions)
        .where(eq(pkbAttributeDefinitions.id, input.definitionId));
      if (!definition) throw new PkbError("That attribute does not exist.", 404);
      if (definition.status !== "approved") throw new PkbError(`${definition.label} is not an approved attribute.`);
      definitionId = definition.id;
    }
    if (familyId) {
      const [family] = await tx
        .select({ id: pkbFamilies.id, status: pkbFamilies.status })
        .from(pkbFamilies)
        .where(eq(pkbFamilies.id, familyId));
      if (!family) throw new PkbError("That family does not exist.", 404);
      if (family.status !== "approved") throw new PkbError("A mapping can only be scoped to an approved family.");
    }

    // One live decision per label, context and family; the previous one is
    // retired rather than overwritten, so the history stays readable.
    await tx
      .update(pkbLabelMappings)
      .set({ status: "retired" })
      .where(
        and(
          eq(pkbLabelMappings.labelNormalized, normalized),
          eq(pkbLabelMappings.context, input.context),
          familyId ? eq(pkbLabelMappings.familyId, familyId) : isNull(pkbLabelMappings.familyId),
          eq(pkbLabelMappings.status, "approved"),
        ),
      );

    const [mapping] = await tx
      .insert(pkbLabelMappings)
      .values({
        label,
        labelNormalized: normalized,
        context: input.context,
        familyId,
        action: input.action,
        definitionId,
        note: input.note?.trim() || null,
        decidedBy: staff.id,
      })
      .returning({ id: pkbLabelMappings.id });

    const queued = await queueListingsForLabel(tx, normalized, input.context, familyId);

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.label_mapped",
        entityType: "pkb_label_mapping",
        entityId: mapping.id,
        after: { label, context: input.context, familyId, action: input.action, definitionId, listingsQueued: queued },
      },
      tx,
    );
    return { mappingId: mapping.id, listingsQueued: queued };
  }
}

/** Withdraws a mapping. Affected listings are re-synced, so their rows return to the queue. */
export async function retireLabelMapping(actor: SessionUser | null, mappingId: string): Promise<{ listingsQueued: number }> {
  const staff = requirePermission(actor, "knowledge.manage");
  return db.transaction(async (tx) => {
    const [mapping] = await tx.select().from(pkbLabelMappings).where(eq(pkbLabelMappings.id, mappingId));
    if (!mapping) throw new PkbError("That mapping does not exist.", 404);
    if (mapping.status !== "approved") return { listingsQueued: 0 };
    await tx.update(pkbLabelMappings).set({ status: "retired" }).where(eq(pkbLabelMappings.id, mappingId));
    const queued = await queueListingsForLabel(tx, mapping.labelNormalized, mapping.context, mapping.familyId);
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.label_mapped",
        entityType: "pkb_label_mapping",
        entityId: mappingId,
        before: { status: "approved", action: mapping.action, definitionId: mapping.definitionId },
        after: { status: "retired", listingsQueued: queued },
      },
      tx,
    );
    return { listingsQueued: queued };
  });
}

function contextMatches(context: PkbLabelContext, legacyRef: string): boolean {
  const rowContext = contextForLegacyRef(legacyRef);
  if (!rowContext) return false;
  return context === "any" || context === rowContext;
}

/**
 * Queues the listings whose mirrored values a mapping changes: both the rows
 * still waiting under this label and the values already written through a
 * mapping of it, so withdrawing one is picked up too.
 */
async function queueListingsForLabel(
  executor: Executor,
  labelNormalized: string,
  context: PkbLabelContext,
  familyId: string | null,
): Promise<number> {
  const familyFilter = familyId ? sql`and kp.family_id = ${familyId}` : sql``;
  const [waiting, written] = await Promise.all([
    queryRows<{ product_id: string; legacy_ref: string; label: string }>(
      executor,
      sql`
        select u.product_id, u.legacy_ref, u.label
        from pkb_unmapped_values u
        join products p on p.id = u.product_id
        left join pkb_products kp on kp.id = p.pkb_product_id
        where u.status = 'open' and u.label is not null ${familyFilter}
      `,
    ),
    queryRows<{ product_id: string; legacy_ref: string; label: string }>(
      executor,
      sql`
        select p.id as product_id, coalesce(f.legacy_ref, '') as legacy_ref, f.raw_label as label
        from pkb_facts f
        join products p on p.pkb_product_id = f.pkb_product_id
        left join pkb_products kp on kp.id = f.pkb_product_id
        where f.raw_label is not null ${familyFilter}
      `,
    ),
  ]);

  const ids = new Set<string>();
  for (const row of [...waiting, ...written]) {
    if (labelKey(row.label ?? "") !== labelNormalized) continue;
    if (!contextMatches(context, row.legacy_ref)) continue;
    ids.add(row.product_id);
  }
  if (ids.size === 0) return 0;
  for (const productId of ids) {
    await executor
      .insert(pkbSyncQueue)
      .values({ productId })
      .onConflictDoUpdate({ target: pkbSyncQueue.productId, set: { queuedAt: new Date() } });
  }
  return ids.size;
}
