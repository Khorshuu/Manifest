import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  products,
  seoFieldHistory,
  seoFieldStates,
  SEO_FIELDS,
  type SeoChangeWorkflow,
  type SeoField,
  type SeoFieldState,
} from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { Executor } from "@/lib/pkb/common";

/**
 * Who decided each SEO field, and what may change it (D-077).
 *
 * The problem this solves: a generator that fills empty fields is useful, and a
 * generator that quietly rewrites the sentence a merchandiser spent an hour on
 * is not. So every field carries a state.
 *
 *  - **AUTO** — nobody has decided. A generator may fill it (through review).
 *  - **SUGGESTED** — a generator proposed this wording; it is not a decision.
 *  - **MANUAL** — a person wrote it. Automatic paths leave it alone.
 *  - **LOCKED** — a person fixed it. Nothing automatic may touch it, and an
 *    apply naming it is refused rather than quietly skipped.
 *
 * The state is a record of provenance, not a permission system: staff can
 * always change a field by hand through the editor, which is what makes it
 * MANUAL. What the state governs is what *automation* may do.
 */

export class SeoFieldError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SeoFieldError";
    this.status = status;
  }
}

export type FieldStateRow = {
  field: SeoField;
  state: SeoFieldState;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
};

const FIELD_LABELS: Record<SeoField, string> = {
  seoFocusKeyword: "Focus keyword",
  seoMetaTitle: "SEO title",
  seoMetaDescription: "Meta description",
  canonicalUrl: "Canonical address",
  seoNoIndex: "Hidden from search",
  slug: "Web address",
  title: "Product name",
  descriptionHtml: "Description",
  bulletFeatures: "Key features",
  tags: "Tags",
  searchKeywords: "Search terms",
  imageAlts: "Photo descriptions",
};

export function seoFieldLabel(field: SeoField): string {
  return FIELD_LABELS[field] ?? field;
}

export function isSeoField(value: string): value is SeoField {
  return (SEO_FIELDS as readonly string[]).includes(value);
}

/** The states of one listing's fields. A field with no row is AUTO. */
export async function fieldStates(executor: Executor, productId: string): Promise<Map<SeoField, FieldStateRow>> {
  const rows: FieldStateRow[] = await executor
    .select({
      field: seoFieldStates.field,
      state: seoFieldStates.state,
      decidedBy: seoFieldStates.decidedBy,
      decidedAt: seoFieldStates.decidedAt,
      note: seoFieldStates.note,
    })
    .from(seoFieldStates)
    .where(eq(seoFieldStates.productId, productId));
  return new Map(rows.map((row) => [row.field, row]));
}

export function stateOf(states: Map<SeoField, FieldStateRow>, field: SeoField): SeoFieldState {
  return states.get(field)?.state ?? "AUTO";
}

/** Fields an automatic path must not write. */
export async function lockedFields(executor: Executor, productId: string): Promise<SeoField[]> {
  const states = await fieldStates(executor, productId);
  return [...states.values()].filter((row) => row.state === "LOCKED").map((row) => row.field);
}

export type FieldWrite = {
  field: SeoField;
  before: unknown;
  after: unknown;
  /** How the value came about, which decides the state it is stored with. */
  origin: "staff" | "generated" | "accepted";
  runId?: string | null;
  reason: string;
  /** Which path made the change, kept in the change history (D-098). */
  workflow?: SeoChangeWorkflow;
};

/** The workflow a write belongs to when the caller does not name one. */
function workflowFor(write: FieldWrite): SeoChangeWorkflow {
  if (write.workflow) return write.workflow;
  if (write.origin === "accepted") return "seo_pulse_apply";
  if (write.origin === "generated") return "seo_pulse_fill";
  return "editor";
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function stateFor(origin: FieldWrite["origin"]): SeoFieldState {
  // A value a person typed or approved is theirs; a generator's is a
  // suggestion even once it has been written into the field.
  return origin === "generated" ? "SUGGESTED" : "MANUAL";
}

/**
 * Records what changed, with its before and after, and moves the field's state
 * (finding F9). Must run inside the transaction that writes the values, so a
 * rolled-back save leaves no history claiming it happened.
 *
 * A LOCKED field is refused here, whatever the caller intended, unless the
 * change comes from a person: the lock exists to stop automation.
 */
export async function recordFieldWrites(
  executor: Executor,
  productId: string,
  actorId: string | null,
  writes: FieldWrite[],
): Promise<SeoField[]> {
  if (writes.length === 0) return [];
  const states = await fieldStates(executor, productId);
  const written: SeoField[] = [];
  const now = new Date();

  for (const write of writes) {
    const before = asText(write.before);
    const after = asText(write.after);
    if (before === after) continue;

    const current = stateOf(states, write.field);
    if (current === "LOCKED" && write.origin !== "staff") {
      throw new SeoFieldError(
        `${seoFieldLabel(write.field)} is locked. Unlock it first if you want SEO Pulse to change it.`,
        409,
      );
    }

    const nextState = stateFor(write.origin);
    // A locked field a person edits stays locked: they did not unlock it.
    const state = current === "LOCKED" ? "LOCKED" : nextState;

    await executor
      .insert(seoFieldStates)
      .values({
        productId,
        field: write.field,
        state,
        decidedBy: state === "AUTO" ? null : actorId,
        decidedAt: state === "AUTO" ? null : now,
        sourceRunId: write.runId ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [seoFieldStates.productId, seoFieldStates.field],
        set: {
          state,
          decidedBy: state === "AUTO" ? null : actorId,
          decidedAt: state === "AUTO" ? null : now,
          sourceRunId: write.runId ?? null,
          updatedAt: now,
        },
      });

    await executor.insert(seoFieldHistory).values({
      productId,
      field: write.field,
      beforeValue: before,
      afterValue: after,
      beforeState: current,
      afterState: state,
      actorUserId: actorId,
      sourceRunId: write.runId ?? null,
      reason: write.reason.slice(0, 300),
      workflow: workflowFor(write),
    });
    written.push(write.field);
  }
  return written;
}

/**
 * Locks or unlocks a field. Locking needs a value to lock: locking an empty
 * field would only stop it ever being filled.
 */
export async function setFieldLock(
  actor: SessionUser | null,
  productId: string,
  field: SeoField,
  lock: boolean,
  note?: string | null,
): Promise<{ state: SeoFieldState }> {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const [listing] = await tx.select().from(products).where(eq(products.id, productId));
    if (!listing) throw new SeoFieldError("That product was not found.", 404);

    const states = await fieldStates(tx, productId);
    const current = stateOf(states, field);
    if (lock && current === "LOCKED") return { state: current };
    if (!lock && current !== "LOCKED") return { state: current };

    const value = asText((listing as Record<string, unknown>)[field]);
    if (lock && (value === null || value.trim() === "")) {
      throw new SeoFieldError(`${seoFieldLabel(field)} is empty. Write it first, then lock it.`);
    }

    const state: SeoFieldState = lock ? "LOCKED" : "MANUAL";
    const now = new Date();
    await tx
      .insert(seoFieldStates)
      .values({ productId, field, state, decidedBy: staff.id, decidedAt: now, note: note ?? null, updatedAt: now })
      .onConflictDoUpdate({
        target: [seoFieldStates.productId, seoFieldStates.field],
        set: { state, decidedBy: staff.id, decidedAt: now, note: note ?? null, updatedAt: now },
      });
    await tx.insert(seoFieldHistory).values({
      productId,
      field,
      beforeValue: value,
      afterValue: value,
      beforeState: current,
      afterState: state,
      actorUserId: staff.id,
      reason: lock ? (note?.slice(0, 300) ?? "Locked by staff") : "Unlocked by staff",
      workflow: "lock",
    });
    return { state };
  });
}

/** One listing's field history, newest first, for the SEO panel. */
export async function fieldHistory(executor: Executor, productId: string, limit = 50) {
  return executor
    .select()
    .from(seoFieldHistory)
    .where(eq(seoFieldHistory.productId, productId))
    .orderBy(seoFieldHistory.createdAt)
    .limit(limit);
}

/** The states of many listings at once, for the health screen. */
export async function fieldStatesFor(
  executor: Executor,
  productIds: string[],
  field: SeoField,
): Promise<Map<string, SeoFieldState>> {
  if (productIds.length === 0) return new Map();
  const rows: { productId: string; state: SeoFieldState }[] = await executor
    .select({ productId: seoFieldStates.productId, state: seoFieldStates.state })
    .from(seoFieldStates)
    .where(and(inArray(seoFieldStates.productId, productIds), eq(seoFieldStates.field, field)));
  return new Map(rows.map((row) => [row.productId, row.state]));
}

/**
 * Who owns what a field holds now (D-120) — the question SEO Pulse asks before
 * it offers to replace a field.
 *
 *  - **empty** — nothing to protect.
 *  - **seo_pulse** — SEO Pulse wrote exactly this value, and nobody has
 *    changed it since. Replacing it with a newer SEO Pulse version needs a
 *    click, never a confirmation that someone's writing is being lost.
 *  - **staff** — a person wrote it, edited SEO Pulse's version, or it came
 *    from a path that kept no history (an import, an older listing). Replacing
 *    it is always a deliberate choice.
 *  - **locked** — a person fixed it. SEO Pulse does not offer to replace it.
 *
 * The field state alone cannot tell the second from the third: an applied
 * recommendation is MANUAL, exactly like a typed one, because a person chose
 * it. The append-only history can. Its latest row for the field says which
 * workflow wrote it, and its after-value says whether that is still what the
 * field holds — any later edit, in any path that records history, is a newer
 * row, and any path that does not record history leaves a value the history
 * does not match. Either way the answer is "staff", which is the safe one.
 */
export type ContentOwner = "empty" | "seo_pulse" | "staff" | "locked";

const SEO_PULSE_WORKFLOWS: readonly SeoChangeWorkflow[] = ["seo_pulse_apply", "seo_pulse_fill"];

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export async function contentOwnership<F extends Exclude<SeoField, "imageAlts">>(
  executor: Executor,
  productId: string,
  fields: readonly F[],
): Promise<Map<F, ContentOwner>> {
  const owners = new Map<F, ContentOwner>();
  if (fields.length === 0) return owners;
  const [listing] = await executor.select().from(products).where(eq(products.id, productId));
  if (!listing) return owners;

  const states = await fieldStates(executor, productId);
  const history: { field: SeoField; afterValue: string | null; workflow: SeoChangeWorkflow }[] = await executor
    .select({ field: seoFieldHistory.field, afterValue: seoFieldHistory.afterValue, workflow: seoFieldHistory.workflow })
    .from(seoFieldHistory)
    .where(and(eq(seoFieldHistory.productId, productId), inArray(seoFieldHistory.field, [...fields])))
    .orderBy(desc(seoFieldHistory.createdAt));
  const latest = new Map<SeoField, (typeof history)[number]>();
  for (const row of history) if (!latest.has(row.field)) latest.set(row.field, row);

  for (const field of fields) {
    const value = (listing as Record<string, unknown>)[field];
    if (isEmptyValue(value)) owners.set(field, "empty");
    else if (stateOf(states, field) === "LOCKED") owners.set(field, "locked");
    else {
      const last = latest.get(field);
      const unchanged = last !== undefined && SEO_PULSE_WORKFLOWS.includes(last.workflow) && last.afterValue === asText(value);
      owners.set(field, unchanged ? "seo_pulse" : "staff");
    }
  }
  return owners;
}
