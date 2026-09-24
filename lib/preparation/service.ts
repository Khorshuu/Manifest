import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { productPreparationRuns, products, users, type ProductPreparationRun } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import type { UserRole } from "@/db/schema";
import { updateProduct } from "@/lib/catalog/products";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { enqueueJob } from "@/lib/jobs/runner";
import { addProductSource, provideDocument } from "@/lib/pkb/enrichment";
import { productPatchSchema } from "@/lib/validation/catalog";
import { FINISHED_STAGES, PREPARATION_CODES, type PreparationView } from "./types";

/**
 * Product preparation: the staff-facing half (D-112).
 *
 * One action — *research and prepare this product* — is a sequence of things
 * that already exist: synchronise the listing's knowledge, settle which
 * product it is, find sources, enrich from them, wait for whatever a person
 * has to decide, generate the content, let the search index catch up, and
 * measure the page. None of that is reimplemented here. This module starts the
 * sequence, reports where it has got to, and lets somebody supply what it is
 * waiting for.
 *
 * It is a job, not a request. Enrichment retrieves pages over the network and
 * review takes as long as a person takes, so a staff member who starts a run
 * and closes the tab must be able to come back to it — and a worker that dies
 * half-way must be able to pick it up at the step it reached (`lib/preparation/runner.ts`).
 *
 * Permissions are exactly the existing ones. Preparing a product is a
 * catalogue action and asks for `catalog.manage`; nothing here approves a
 * source domain, a trust policy or a verification policy, all of which
 * continue to ask for `knowledge.manage` in `lib/pkb`.
 */

export const PREPARATION_JOB = "catalog.prepare_product";

export type StartPreparationInput = {
  /** One click's key: sending it again returns the same run. */
  requestKey: string;
  /** Identity to record before preparing, applied through the normal product save. */
  identity?: Record<string, string | null>;
  /** Addresses to attach to the product as sources. */
  urls?: string[];
  /** A document a person holds, as text. */
  document?: { title: string; content: string; contentType?: "text/plain" | "text/html" | "application/json"; url?: string | null };
};

export function toView(row: ProductPreparationRun): PreparationView {
  return {
    id: row.id,
    productId: row.productId,
    pkbProductId: row.pkbProductId,
    stage: row.stage,
    active: !FINISHED_STAGES.has(row.stage) && row.stage !== "NEEDS_REVIEW",
    steps: row.steps ?? [],
    review: row.review ?? [],
    failure: row.failure ?? null,
    providers: row.providers ?? [],
    enrichmentRunId: row.enrichmentRunId,
    seoRunId: row.seoRunId,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

/** Wakes a run up: the same key while a wake-up is pending is ignored. */
export async function wakePreparation(
  runId: string,
  options: { ticks: number; delaySeconds?: number },
  executor: typeof db | Parameters<typeof enqueueJob>[1] = db,
): Promise<void> {
  await enqueueJob(
    {
      kind: PREPARATION_JOB,
      payload: { runId },
      runAt: new Date(Date.now() + (options.delaySeconds ?? 0) * 1000),
      // The tick is part of the key so each wait schedules exactly one
      // wake-up, and a retried enqueue for the same wait is dropped.
      dedupeKey: `${PREPARATION_JOB}:${runId}:${options.ticks}`,
      maxAttempts: 4,
    },
    executor,
  );
}

/**
 * Starts preparation for one product, or returns the run already preparing it.
 *
 * Idempotent twice over: the same request key returns the run it created, and
 * a product may only have one live run at a time (a partial unique index, so
 * two requests racing cannot both create one). Pressing the button while a run
 * is waiting for review returns that run rather than starting a second one
 * that would ask for the same decision again.
 */
export async function startPreparation(
  actor: SessionUser | null,
  productId: string,
  input: StartPreparationInput,
): Promise<PreparationView> {
  const staff = requirePermission(actor, "catalog.manage");

  const [product] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId));
  if (!product) throw new NotFoundError("That product was not found.");

  // Anything the caller supplied goes in first, through the paths that already
  // check it: the product save validates and re-resolves the identity, and the
  // source paths keep provenance. A run then starts from the fuller product.
  await supply(staff, productId, input);

  const existingByKey = await findByRequestKey(input.requestKey);
  if (existingByKey) {
    if (existingByKey.productId !== productId) {
      throw new ConflictError("That request key belongs to another product.");
    }
    return toView(existingByKey);
  }

  const live = await findLive(productId);
  if (live) return toView(live);

  let created: ProductPreparationRun;
  try {
    [created] = await db
      .insert(productPreparationRuns)
      .values({ productId, requestKey: input.requestKey, requestedBy: staff.id })
      .returning();
  } catch (error) {
    // Two requests raced: one created the live run, this one takes it.
    const raced = (await findByRequestKey(input.requestKey)) ?? (await findLive(productId));
    if (!raced) throw error;
    return toView(raced);
  }

  await wakePreparation(created.id, { ticks: 0 });
  await recordAudit({
    actorUserId: staff.id,
    action: "product.preparation_started",
    entityType: "product",
    entityId: productId,
    after: { runId: created.id },
  });
  return toView(created);
}

/** The product's latest run, whatever state it is in. */
export async function getPreparation(
  actor: SessionUser | null,
  productId: string,
): Promise<PreparationView | null> {
  requirePermission(actor, "catalog.manage");
  const [row] = await db
    .select()
    .from(productPreparationRuns)
    .where(eq(productPreparationRuns.productId, productId))
    .orderBy(desc(productPreparationRuns.createdAt))
    .limit(1);
  return row ? toView(row) : null;
}

export async function getPreparationRun(
  actor: SessionUser | null,
  runId: string,
): Promise<PreparationView | null> {
  requirePermission(actor, "catalog.manage");
  const [row] = await db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
  return row ? toView(row) : null;
}

/**
 * Runs a stopped run again from where it stopped.
 *
 * Safe because the steps it already completed are recorded: a retry does not
 * enrich again, does not propose the same claims again and does not generate
 * again. It re-checks the step that stopped it, which is the only thing that
 * can have changed.
 */
export async function retryPreparation(actor: SessionUser | null, runId: string): Promise<PreparationView> {
  const staff = requirePermission(actor, "catalog.manage");

  const row = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(productPreparationRuns)
      .where(eq(productPreparationRuns.id, runId))
      .for("update");
    if (!current) throw new NotFoundError("That preparation run was not found.");
    if (current.stage === "CANCELLED") throw new ConflictError("That preparation run was cancelled. Start a new one.");
    if (current.stage === "READY") return current;

    // A live run is already going to move on its own; nudging it is enough.
    const finished = FINISHED_STAGES.has(current.stage);
    if (!finished && current.stage !== "NEEDS_REVIEW") return current;

    // Another live run would break the one-live-run rule, so a finished run is
    // revived rather than replaced.
    const [live] = await tx
      .select({ id: productPreparationRuns.id })
      .from(productPreparationRuns)
      .where(and(eq(productPreparationRuns.productId, current.productId), isNull(productPreparationRuns.finishedAt)));
    if (live && live.id !== current.id) {
      throw new ConflictError("This product is already being prepared.");
    }

    const [revived] = await tx
      .update(productPreparationRuns)
      .set({
        stage: "IDENTIFYING",
        failure: null,
        review: [],
        cancelRequested: false,
        finishedAt: null,
        ticks: current.ticks + 1,
        updatedAt: new Date(),
      })
      .where(eq(productPreparationRuns.id, runId))
      .returning();
    return revived;
  });

  if (row.stage !== "READY" && row.stage !== "CANCELLED") {
    await wakePreparation(row.id, { ticks: row.ticks });
  }
  await recordAudit({
    actorUserId: staff.id,
    action: "product.preparation_retried",
    entityType: "product",
    entityId: row.productId,
    after: { runId: row.id, from: row.stage },
  });
  return toView(row);
}

/**
 * Asks a run to stop.
 *
 * Cancellation is cooperative, because the work a run starts belongs to other
 * systems: an enrichment run already retrieving a page finishes retrieving it,
 * and the evidence it recorded stays. What cancelling does is stop the
 * sequence from going on to the next step, which is the only part preparation
 * owns.
 */
export async function cancelPreparation(actor: SessionUser | null, runId: string): Promise<PreparationView> {
  const staff = requirePermission(actor, "catalog.manage");

  const row = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(productPreparationRuns)
      .where(eq(productPreparationRuns.id, runId))
      .for("update");
    if (!current) throw new NotFoundError("That preparation run was not found.");
    if (current.finishedAt) return current;

    // Nothing of this run's own is in flight while it is waiting for a person,
    // so that case stops immediately rather than at the next wake-up.
    const stopNow = current.stage === "NEEDS_REVIEW";
    const [updated] = await tx
      .update(productPreparationRuns)
      .set({
        cancelRequested: true,
        ...(stopNow ? { stage: "CANCELLED" as const, finishedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(productPreparationRuns.id, runId))
      .returning();
    return updated;
  });

  await recordAudit({
    actorUserId: staff.id,
    action: "product.preparation_cancelled",
    entityType: "product",
    entityId: row.productId,
    after: { runId: row.id, stage: row.stage },
  });
  return toView(row);
}

/**
 * Supplies what a waiting run asked for, and continues it.
 *
 * Every piece goes in through its existing path — the product save for
 * identity, `addProductSource` for an address, `provideDocument` for text a
 * person holds — so validation, provenance, permission and the knowledge
 * lock all behave exactly as they do when those paths are used directly.
 */
export async function continuePreparation(
  actor: SessionUser | null,
  runId: string,
  input: Omit<StartPreparationInput, "requestKey"> = {},
): Promise<PreparationView> {
  const staff = requirePermission(actor, "catalog.manage");

  const [current] = await db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
  if (!current) throw new NotFoundError("That preparation run was not found.");
  if (current.stage === "CANCELLED") throw new ConflictError("That preparation run was cancelled. Start a new one.");

  await supply(staff, current.productId, input);

  const [updated] = await db
    .update(productPreparationRuns)
    .set({
      stage: FINISHED_STAGES.has(current.stage) || current.stage === "NEEDS_REVIEW" ? "IDENTIFYING" : current.stage,
      review: [],
      failure: null,
      finishedAt: null,
      ticks: current.ticks + 1,
      updatedAt: new Date(),
    })
    .where(eq(productPreparationRuns.id, runId))
    .returning();

  await wakePreparation(updated.id, { ticks: updated.ticks });
  return toView(updated);
}

// ------------------------------------------------------------------ helpers

async function supply(
  staff: SessionUser,
  productId: string,
  input: Omit<StartPreparationInput, "requestKey">,
): Promise<void> {
  if (input.identity && Object.keys(input.identity).length > 0) {
    // Parsed against the product save's own schema, so nothing reaches the
    // catalogue through preparation that could not be saved by hand.
    const parsed = productPatchSchema.safeParse({ identity: input.identity });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the identity fields.");
    }
    await updateProduct(staff, productId, parsed.data);
  }

  const pkbProductId = await knowledgeProductOf(productId);
  if (!pkbProductId) {
    if ((input.urls?.length ?? 0) > 0 || input.document) {
      throw new ConflictError("Save the product before attaching sources to it.");
    }
    return;
  }

  for (const url of input.urls ?? []) {
    await addProductSource(staff, pkbProductId, { url });
  }
  if (input.document) {
    await provideDocument(staff, pkbProductId, input.document);
  }
}

async function knowledgeProductOf(productId: string): Promise<string | null> {
  const [row] = await db
    .select({ pkbProductId: products.pkbProductId })
    .from(products)
    .where(eq(products.id, productId));
  return row?.pkbProductId ?? null;
}

async function findByRequestKey(requestKey: string): Promise<ProductPreparationRun | undefined> {
  const [row] = await db
    .select()
    .from(productPreparationRuns)
    .where(eq(productPreparationRuns.requestKey, requestKey));
  return row;
}

async function findLive(productId: string): Promise<ProductPreparationRun | undefined> {
  const [row] = await db
    .select()
    .from(productPreparationRuns)
    .where(and(eq(productPreparationRuns.productId, productId), isNull(productPreparationRuns.finishedAt)));
  return row;
}

/**
 * The staff member a run was started by, as the session that started it.
 *
 * The job runs with nobody signed in, and the work it does — a knowledge sync,
 * an enrichment request, a research run — is attributed to a person and
 * checked against their permissions. Rather than giving the worker a way past
 * those checks, it acts as the person who asked, whose permission was checked
 * when the run was created and is checked again by each function it calls. An
 * account that has since lost the permission, or been removed, stops the run.
 */
export async function actorOf(userId: string | null): Promise<SessionUser | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  return row ? { id: row.id, email: row.email, role: row.role as UserRole } : null;
}

/** The codes a caller may see, re-exported so a route does not reach into types. */
export { PREPARATION_CODES };

/** Counts by stage, for an operations view. */
export async function preparationSummary(actor: SessionUser | null) {
  requirePermission(actor, "catalog.manage");
  return db
    .select({ stage: productPreparationRuns.stage, total: sql<number>`count(*)::int` })
    .from(productPreparationRuns)
    .groupBy(productPreparationRuns.stage);
}
