import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  pkbAttributeProposals,
  pkbClaims,
  pkbEnrichmentRuns,
  pkbSourceDocuments,
  pkbSources,
  productPreparationRuns,
  productSearchQueue,
  products,
  seoResearchRuns,
  type ProductPreparationRun,
  type PreparationStepRecord,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { staffChange } from "@/lib/pkb/common";
import { enrichmentFailure, requestEnrichment, sourceOutlook } from "@/lib/pkb/enrichment";
import { canEnrich } from "@/lib/pkb/resolution";
import { reassessResolution } from "@/lib/pkb/resolution";
import { beginListingChange, syncListingKnowledge } from "@/lib/pkb/sync";
import { logEvent } from "@/lib/observability/log";
import { enqueueUniquePending } from "@/lib/jobs/runner";
import { knowledgeSufficiency } from "@/lib/seo-pulse/facts";
import { applyPreparedContent, loadPulseInput, runSeoPulse, SeoPulseError } from "@/lib/seo-pulse/service";
import { searchReadiness, seoReadiness } from "@/lib/seo/readiness";
import { actorOf, wakePreparation } from "./service";
import {
  PREPARATION_CODES,
  PREPARATION_STEPS,
  STEP_STAGE,
  type PreparationNote,
  type PreparationStep,
} from "./types";

/**
 * Product preparation: the worker (D-112).
 *
 * The sequence, in order, each step doing nothing itself and delegating to the
 * system that owns the work:
 *
 *  1. identity     — `syncListingKnowledge` then `reassessResolution`.
 *  2. sources      — `sourceOutlook`: the registry, what staff attached, and
 *                    the research provider only when there is nothing else.
 *  3. enrichment   — `requestEnrichment`, then waiting for that run.
 *  4. verification — reading what the run proposed. Nothing is accepted here.
 *  5. content      — `runSeoPulse`, once there is enough established fact.
 *  6. listing      — `applyPreparedContent`: the wording written into the
 *                    fields that are empty or still SeoPulse's own (D-122).
 *  7. search       — waiting for the search index to catch up.
 *  8. page         — `seoReadiness` and `searchReadiness`.
 *
 * Three rules hold the whole thing together.
 *
 * **A step is recorded when it has finished, and never re-run.** That is what
 * makes a retry idempotent: a retried run does not enrich a second time, does
 * not propose the same claims a second time and does not generate a second
 * analysis. Where a step's own work is also idempotent — it usually is — that
 * is a second line of defence, not the first.
 *
 * **Waiting is a job, not a loop.** Enrichment and research happen in their own
 * jobs; this one re-schedules itself with a growing tick count and returns, so
 * a worker restart loses nothing and a serverless function is never held open.
 *
 * **It never decides anything a person decides.** An ambiguous identity, a
 * conflicting claim, a claim waiting for review and a product with too little
 * established fact all stop the run. It does not confirm an identity, accept a
 * claim or approve a domain (D-072, D-074, D-076). Generated wording is
 * written only where nobody's writing is replaced (D-122).
 */

/** Wake-ups before a waiting run gives up, and the gap between them. */
const MAX_TICKS = 90;
const WAIT_SECONDS = 8;

type Outcome =
  | { kind: "done"; detail: string; state?: PreparationStepRecord["state"]; fields?: PreparationStepRecord["fields"] }
  | { kind: "wait"; detail: string }
  | { kind: "review"; notes: PreparationNote[] }
  | { kind: "blocked"; failure: PreparationNote }
  | { kind: "failed"; failure: PreparationNote };

type Context = {
  run: ProductPreparationRun;
  actor: SessionUser;
  productId: string;
  pkbProductId: string | null;
};

/**
 * Advances one run as far as it can go, then returns. The job handler.
 *
 * A run that is finished, cancelled or missing is left exactly as it is, so a
 * retried job cannot restart a run somebody stopped or overwrite a finished
 * one.
 */
export async function advancePreparation(runId: string): Promise<{ stage: string }> {
  const [run] = await db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, runId));
  if (!run) return { stage: "missing" };
  if (run.finishedAt) return { stage: run.stage };

  if (run.cancelRequested) {
    await finish(run.id, "CANCELLED", { failure: null });
    return { stage: "CANCELLED" };
  }

  const actor = await actorOf(run.requestedBy);
  if (!actor) {
    await finish(run.id, "FAILED", {
      failure: {
        code: PREPARATION_CODES.PRODUCT_REMOVED,
        message: "The account that started this preparation no longer exists.",
        remedy: "Start preparation again from an account that may manage the catalogue.",
      },
    });
    return { stage: "FAILED" };
  }

  const [product] = await db
    .select({ id: products.id, pkbProductId: products.pkbProductId })
    .from(products)
    .where(eq(products.id, run.productId));
  if (!product) {
    await finish(run.id, "FAILED", {
      failure: {
        code: PREPARATION_CODES.PRODUCT_REMOVED,
        message: "The product was removed while it was being prepared.",
        remedy: "Nothing to do. The run is kept as a record.",
      },
    });
    return { stage: "FAILED" };
  }

  const context: Context = {
    run,
    actor,
    productId: run.productId,
    pkbProductId: product.pkbProductId,
  };

  const done = new Set((run.steps ?? []).map((step) => step.key));
  let steps = [...(run.steps ?? [])];

  for (const step of PREPARATION_STEPS) {
    if (done.has(step)) continue;

    await db
      .update(productPreparationRuns)
      .set({ stage: STEP_STAGE[step], updatedAt: new Date() })
      .where(eq(productPreparationRuns.id, run.id));

    let outcome: Outcome;
    try {
      outcome = await STEP_RUNNERS[step](context);
    } catch (error) {
      // An unexpected failure is the run's, not the product's: nothing this
      // step was going to write has been written, and the message a person
      // sees never carries the underlying error text.
      logEvent("warn", "preparation.step_failed", {
        runId: run.id,
        step,
        error: error instanceof Error ? error.message : String(error),
      });
      await finish(run.id, "FAILED", {
        failure: {
          code: PREPARATION_CODES.CONTENT_FAILED,
          message: `Preparation stopped while ${STEP_LABEL[step]}.`,
          remedy: "Try again. If it stops here twice, the background jobs screen records what failed.",
        },
      });
      return { stage: "FAILED" };
    }

    if (outcome.kind === "wait") {
      if (run.ticks >= MAX_TICKS) {
        await finish(run.id, "FAILED", {
          failure: {
            code: PREPARATION_CODES.TOO_LONG,
            message: `Preparation waited too long while ${STEP_LABEL[step]}.`,
            remedy: "Check the background jobs screen, then try again.",
          },
        });
        return { stage: "FAILED" };
      }
      const ticks = run.ticks + 1;
      await db
        .update(productPreparationRuns)
        .set({ ticks, updatedAt: new Date() })
        .where(eq(productPreparationRuns.id, run.id));
      await wakePreparation(run.id, { ticks, delaySeconds: WAIT_SECONDS });
      return { stage: STEP_STAGE[step] };
    }

    if (outcome.kind === "review") {
      await db
        .update(productPreparationRuns)
        .set({ stage: "NEEDS_REVIEW", review: outcome.notes, steps, updatedAt: new Date() })
        .where(eq(productPreparationRuns.id, run.id));
      return { stage: "NEEDS_REVIEW" };
    }

    if (outcome.kind === "blocked" || outcome.kind === "failed") {
      await finish(run.id, outcome.kind === "blocked" ? "BLOCKED" : "FAILED", {
        failure: outcome.failure,
        steps,
      });
      return { stage: outcome.kind === "blocked" ? "BLOCKED" : "FAILED" };
    }

    steps = [
      ...steps,
      {
        key: step,
        state: outcome.state ?? "done",
        detail: outcome.detail,
        at: new Date().toISOString(),
        ...(outcome.fields ? { fields: outcome.fields } : {}),
      },
    ];
    await db
      .update(productPreparationRuns)
      .set({ steps, review: [], updatedAt: new Date() })
      .where(eq(productPreparationRuns.id, run.id));
    // The next step reads the run's own columns (the enrichment run it
    // started, the research run it started), so the copy it holds is refreshed.
    const [fresh] = await db.select().from(productPreparationRuns).where(eq(productPreparationRuns.id, run.id));
    context.run = fresh;
    if (fresh.cancelRequested) {
      await finish(run.id, "CANCELLED", { failure: null });
      return { stage: "CANCELLED" };
    }
  }

  await finish(run.id, "READY", { failure: null, steps });
  return { stage: "READY" };
}

const STEP_LABEL: Record<PreparationStep, string> = {
  identity: "working out which product this is",
  sources: "looking for sources",
  enrichment: "researching the product",
  verification: "checking what the research proposed",
  content: "preparing the content",
  listing: "adding the content to the listing",
  search: "preparing the search index",
  page: "checking the page",
};

async function finish(
  runId: string,
  stage: "READY" | "FAILED" | "BLOCKED" | "CANCELLED",
  extra: { failure?: PreparationNote | null; steps?: PreparationStepRecord[] },
): Promise<void> {
  await db
    .update(productPreparationRuns)
    .set({
      stage,
      finishedAt: new Date(),
      updatedAt: new Date(),
      ...(extra.failure !== undefined ? { failure: extra.failure } : {}),
      ...(extra.steps ? { steps: extra.steps } : {}),
    })
    .where(and(eq(productPreparationRuns.id, runId), sql`finished_at is null`));
}

// ---------------------------------------------------------------- the steps

const STEP_RUNNERS: Record<PreparationStep, (context: Context) => Promise<Outcome>> = {
  identity: stepIdentity,
  sources: stepSources,
  enrichment: stepEnrichment,
  verification: stepVerification,
  content: stepContent,
  listing: stepListing,
  search: stepSearch,
  page: stepPage,
};

/**
 * 1. Identity.
 *
 * The listing's own columns are synchronised into the knowledge base, which is
 * also what creates the knowledge product for a listing that has never had
 * one, and the identity is then re-assessed. The assessment is the gate the
 * rest of the sequence depends on, and it is not weakened here: UNRESOLVED
 * blocks, AMBIGUOUS asks for a person, and VERIFIED is never granted by
 * anything in this file.
 */
async function stepIdentity(context: Context): Promise<Outcome> {
  const pkbProductId = await db.transaction(async (tx) => {
    await beginListingChange(tx, context.productId);
    const report = await syncListingKnowledge(tx, context.productId, staffChange(context.actor.id));
    return report.pkbProductId;
  });

  if (!pkbProductId) {
    return {
      kind: "failed",
      failure: {
        code: PREPARATION_CODES.PRODUCT_REMOVED,
        message: "The product was removed while it was being prepared.",
        remedy: "Nothing to do.",
      },
    };
  }
  context.pkbProductId = pkbProductId;
  await db
    .update(productPreparationRuns)
    .set({ pkbProductId, updatedAt: new Date() })
    .where(eq(productPreparationRuns.id, context.run.id));

  const assessment = await reassessResolution(context.actor, pkbProductId);

  if (assessment.state === "AMBIGUOUS") {
    return {
      kind: "review",
      notes: [
        {
          code: PREPARATION_CODES.IDENTITY_AMBIGUOUS,
          message: `Which product this is cannot be settled: ${assessment.reasons.map((reason) => reason.message).join(" ")}`,
          remedy:
            "Open Product Intelligence and confirm the identity, stating which similar products are different, or correct the identifiers.",
        },
      ],
    };
  }

  if (!canEnrich(assessment.state)) {
    return {
      kind: "blocked",
      failure: {
        code: PREPARATION_CODES.IDENTITY_UNRESOLVED,
        message: `There is not enough to say which product this is: ${assessment.reasons.map((reason) => reason.message).join(" ")}`,
        remedy: "Add the brand and a model number, part number or GTIN, then prepare it again.",
      },
    };
  }

  return { kind: "done", detail: `Identity ${assessment.state}.` };
}

/**
 * 2. Sources.
 *
 * Nothing is retrieved here. The question is only whether a research run would
 * have anything to read, so a product with nothing attached and no automatic
 * discovery is told so plainly rather than being sent through a run that
 * retrieves nothing and reports success.
 */
async function stepSources(context: Context): Promise<Outcome> {
  const outlook = await sourceOutlook(context.pkbProductId!);
  if (outlook.provider) {
    await db
      .update(productPreparationRuns)
      .set({ providers: [outlook.provider], updatedAt: new Date() })
      .where(eq(productPreparationRuns.id, context.run.id));
  }

  const total = outlook.attached + outlook.registry + outlook.discovered;
  if (total > 0) {
    return {
      kind: "done",
      detail: `${total} source${total === 1 ? "" : "s"} to read: ${outlook.attached} attached, ${outlook.registry} from the brand registry, ${outlook.discovered} discovered.`,
    };
  }

  const state = outlook.provider?.status;
  return {
    kind: "blocked",
    failure: {
      code:
        state === "NOT_CONFIGURED"
          ? PREPARATION_CODES.AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED
          : state === "UNAVAILABLE" || state === "FAILED"
            ? PREPARATION_CODES.AUTOMATIC_SOURCE_DISCOVERY_UNAVAILABLE
            : PREPARATION_CODES.NO_SOURCES,
      message:
        state === "NOT_CONFIGURED"
          ? "There is nothing to research this product from, and automatic source discovery is not set up."
          : state === "UNAVAILABLE" || state === "FAILED"
            ? `There is nothing to research this product from, and automatic discovery is unavailable: ${outlook.provider?.message ?? "no reason given"}`
            : "There is nothing to research this product from.",
      remedy:
        "Give the manufacturer's page for this product, or paste its specification, then continue. An approved domain for this brand in the Brand Source Registry would find it automatically next time.",
    },
  };
}

/**
 * 3. Enrichment.
 *
 * One run per preparation. The run's id is kept on the preparation row, so a
 * retried preparation waits for the run it already started rather than
 * starting a second one that would retrieve the same pages and record the same
 * evidence again.
 */
async function stepEnrichment(context: Context): Promise<Outcome> {
  let runId = context.run.enrichmentRunId;

  if (!runId) {
    // One research run per attempt at this step (see the content step's key).
    const requested = await requestEnrichment(context.actor, {
      pkbProductId: context.pkbProductId!,
      requestKey: `preparation:${context.run.id}:${context.run.ticks}`,
    });
    runId = requested.runId;
    await db
      .update(productPreparationRuns)
      .set({ enrichmentRunId: runId, updatedAt: new Date() })
      .where(eq(productPreparationRuns.id, context.run.id));
    context.run = { ...context.run, enrichmentRunId: runId };
    if (requested.status === "blocked") {
      return {
        kind: "blocked",
        failure: {
          code: PREPARATION_CODES.ENRICHMENT_BLOCKED,
          message: requested.blockedReason ?? "Research is not allowed for this product yet.",
          remedy: "Settle the product's identity in Product Intelligence, then prepare it again.",
        },
      };
    }
  }

  const [enrichment] = await db.select().from(pkbEnrichmentRuns).where(eq(pkbEnrichmentRuns.id, runId));
  if (!enrichment) return { kind: "done", detail: "The research run is no longer on record.", state: "degraded" };

  if (enrichment.status === "queued" || enrichment.status === "running") {
    return { kind: "wait", detail: "Research is running." };
  }
  if (enrichment.status === "blocked") {
    return {
      kind: "blocked",
      failure: {
        code: PREPARATION_CODES.ENRICHMENT_BLOCKED,
        message: enrichment.blockedReason ?? "Research was refused for this product.",
        remedy: "Settle the product's identity in Product Intelligence, then prepare it again.",
      },
    };
  }
  if (enrichment.status === "failed") {
    const failure = enrichmentFailure(enrichment.error);
    if (failure.kind !== "other") {
      /*
       * The page was read and could not be stored (D-119). Carrying on would
       * end in "not enough is known about this product", which is untrue —
       * the information was there and was lost. The run is forgotten, so a
       * retry after the cause is fixed researches afresh instead of waiting
       * on this failed one. The database's own account of the failure is on
       * the background jobs screen, which is an administrator's; it is never
       * put in front of product staff.
       */
      await forgetEnrichmentRun(context);
      return {
        kind: "blocked",
        failure: {
          code: PREPARATION_CODES.SOURCE_STORAGE_FAILED,
          message: "We read the product page but could not store the retrieved information.",
          remedy:
            failure.kind === "source_storage_encoding"
              ? "Nothing about the product was changed. The page contains characters this database cannot store — an administrator has to move product knowledge to a UTF-8 database (see Background work for the details). Then try again."
              : "Nothing about the product was changed. An administrator can see what went wrong under Background work. Try again once it is fixed.",
        },
      };
    }
    /*
     * Any other failed research run is not a failed product. Everything the
     * run did retrieve is recorded, the listing is untouched, and preparation
     * carries on to see whether what is already established is enough — which
     * it often is, for a product staff filled in by hand.
     */
    return {
      kind: "done",
      state: "degraded",
      detail: "Research stopped before it finished. Whatever it had already read is kept.",
    };
  }

  const read = enrichment.documentsRetrieved;
  const refused = enrichment.documentsRefused;

  /*
   * A page that names a different product (D-119). Its facts were never
   * proposed (I-13); what a person needs is to see the disagreement and
   * decide — correct the product's identity, give another source, or carry on
   * by hand. Nothing here changes the identity on anyone's behalf.
   */
  if (enrichment.claimsProposed === 0) {
    const mismatched = await db
      .select({ url: pkbSources.url, notes: pkbSourceDocuments.identityNotes })
      .from(pkbSourceDocuments)
      .innerJoin(pkbSources, eq(pkbSources.id, pkbSourceDocuments.sourceId))
      .where(
        and(
          eq(pkbSourceDocuments.runId, runId),
          eq(pkbSourceDocuments.status, "retrieved"),
          eq(pkbSourceDocuments.identityMatch, "mismatch"),
        ),
      )
      .limit(1);
    if (mismatched.length > 0) {
      await forgetEnrichmentRun(context);
      // The identifiers as staff typed them, rather than the matching keys.
      const [listing] = await db
        .select({
          title: products.title,
          brand: products.brand,
          details: products.details,
          identifierValue: products.identifierValue,
        })
        .from(products)
        .where(eq(products.id, context.productId));
      const details = (listing?.details ?? {}) as Record<string, unknown>;
      return {
        kind: "review",
        notes: [
          {
            code: PREPARATION_CODES.SOURCE_IDENTITY_MISMATCH,
            message: "The product page appears to describe a different product.",
            remedy:
              "Check the identifiers below. Correct the product's identity if it is wrong, give the page for this exact product, or continue by hand. Nothing from that page was used.",
            comparison: identityComparison(
              mismatched[0].url,
              mismatched[0].notes,
              listing
                ? {
                    name: listing.title,
                    brands: listing.brand ? [listing.brand] : [],
                    models: [details.modelNumber, details.manufacturerPartNumber]
                      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
                      .filter((value, index, all) => all.indexOf(value) === index),
                    gtins: listing.identifierValue ? [listing.identifierValue] : [],
                  }
                : undefined,
            ),
          },
        ],
      };
    }
  }

  /*
   * A page that was read but judged not to be about this product proposes
   * nothing, by design (D-074, I-13). Saying only "read 1 document, proposed 0
   * values" leaves a staff member with no way to tell that apart from a page
   * that simply had nothing on it, and the next thing they see is a complaint
   * about insufficient knowledge. So the verdict is reported, in the step that
   * produced it.
   */
  const [verdicts] = await db
    .select({
      unmatched: sql<number>`count(*) filter (where ${pkbSourceDocuments.identityMatch} in ('mismatch', 'unknown'))::int`,
    })
    .from(pkbSourceDocuments)
    .where(and(eq(pkbSourceDocuments.runId, runId), eq(pkbSourceDocuments.status, "retrieved")));
  const unmatched = Number(verdicts?.unmatched ?? 0);
  const unmatchedNote =
    unmatched > 0
      ? ` ${unmatched} of them ${unmatched === 1 ? "does" : "do"} not say enough about which product ${unmatched === 1 ? "it is" : "they are"} for, so nothing on ${unmatched === 1 ? "it" : "them"} was used — add the manufacturer's page for this exact model, or paste its specification.`
      : "";

  return {
    kind: "done",
    state: (read === 0 && refused > 0) || (unmatched > 0 && enrichment.claimsProposed === 0) ? "degraded" : "done",
    detail: `Read ${read} document${read === 1 ? "" : "s"}, ${refused} refused; proposed ${enrichment.claimsProposed} value${enrichment.claimsProposed === 1 ? "" : "s"}.${unmatchedNote}`,
  };
}

/**
 * Lets the next attempt start a research run of its own. The finished run and
 * everything it recorded stay; only this preparation's link to it goes.
 */
async function forgetEnrichmentRun(context: Context): Promise<void> {
  await db
    .update(productPreparationRuns)
    .set({ enrichmentRunId: null, updatedAt: new Date() })
    .where(eq(productPreparationRuns.id, context.run.id));
  context.run = { ...context.run, enrichmentRunId: null };
}

/** The identifiers on each side of a mismatch, as a person reads them. */
export function identityComparison(
  url: string | null,
  notes: unknown,
  /** The listing's identifiers as entered; the notes' normalised keys otherwise. */
  recordedAsEntered?: { name?: string; brands?: string[]; models?: string[]; gtins?: string[] },
): NonNullable<PreparationNote["comparison"]> {
  const stored = (notes ?? {}) as {
    recorded?: { name?: string; brands?: string[]; models?: string[]; gtins?: string[] };
    found?: { names?: string[]; brands?: string[]; models?: string[]; skus?: string[]; gtins?: string[] };
  };
  const record = { ...stored, recorded: recordedAsEntered ?? stored.recorded };
  const rows = (entries: [string, unknown][]) =>
    entries
      .map(([label, values]) => ({
        label,
        values: ([] as unknown[]).concat(values ?? []).map(String).filter(Boolean).slice(0, 6),
      }))
      .filter((row) => row.values.length > 0);
  return {
    url,
    recorded: rows([
      ["Name", record.recorded?.name],
      ["Brand", record.recorded?.brands],
      ["Model / part number", record.recorded?.models],
      ["GTIN", record.recorded?.gtins],
    ]),
    found: rows([
      ["Name", record.found?.names],
      ["Brand", record.found?.brands],
      ["Model / part number", record.found?.models],
      ["SKU", record.found?.skus],
      ["GTIN", record.found?.gtins],
    ]),
  };
}

/**
 * 4. Verification.
 *
 * Reading only. A claim the pipeline proposed becomes a fact when a person
 * accepts it under a verification policy, and that has not changed: this step
 * finds out whether anything is waiting for that decision and stops if it is.
 * Auto-accepting to reach a one-click finish is exactly the thing the
 * verification architecture exists to prevent (D-076).
 */
async function stepVerification(context: Context): Promise<Outcome> {
  const [counts] = await db
    .select({
      conflicts: sql<number>`count(*) filter (where ${pkbClaims.status} = 'CONFLICT')::int`,
      waiting: sql<number>`count(*) filter (where ${pkbClaims.status} = 'SUGGESTED')::int`,
    })
    .from(pkbClaims)
    .where(eq(pkbClaims.pkbProductId, context.pkbProductId!));

  const [labels] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(pkbAttributeProposals)
    .where(
      and(
        eq(pkbAttributeProposals.pkbProductId, context.pkbProductId!),
        eq(pkbAttributeProposals.status, "open"),
      ),
    );

  const notes: PreparationNote[] = [];
  if (Number(counts?.conflicts ?? 0) > 0) {
    notes.push({
      code: PREPARATION_CODES.CLAIMS_CONFLICT,
      message: `${counts.conflicts} value${counts.conflicts === 1 ? "" : "s"} where the sources disagree with each other or with what is recorded.`,
      remedy: "Open Product Intelligence and decide which value is right. Nothing is accepted until you do.",
    });
  }
  if (Number(counts?.waiting ?? 0) > 0) {
    notes.push({
      code: PREPARATION_CODES.CLAIMS_WAITING,
      message: `${counts.waiting} value${counts.waiting === 1 ? "" : "s"} proposed from sources, waiting for someone to accept or reject them.`,
      remedy: "Open Product Intelligence and review them. Accepted values then count as established knowledge.",
    });
  }
  if (Number(labels?.open ?? 0) > 0) {
    notes.push({
      code: PREPARATION_CODES.LABELS_WAITING,
      message: `${labels.open} label${labels.open === 1 ? "" : "s"} found in the sources that no attribute names yet.`,
      remedy: "Decide what each one is — an attribute of this kind of product, of this product only, or not an attribute.",
    });
  }

  if (notes.length > 0) return { kind: "review", notes };
  return { kind: "done", detail: "Nothing is waiting for a decision." };
}

/**
 * 5. Content.
 *
 * Generation runs only when there is enough established fact to write from
 * (D-115). This step generates; the next one decides what of it may be
 * written into the listing without replacing anybody's writing (D-122).
 */
async function stepContent(context: Context): Promise<Outcome> {
  const input = await loadPulseInput(context.productId);
  if (!input) {
    return {
      kind: "failed",
      failure: {
        code: PREPARATION_CODES.PRODUCT_REMOVED,
        message: "The product was removed while it was being prepared.",
        remedy: "Nothing to do.",
      },
    };
  }

  const sufficiency = knowledgeSufficiency(input);
  if (!sufficiency.sufficient) {
    return {
      kind: "review",
      notes: [
        {
          code: PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE,
          message: `There is too little established about this product to write a product listing from: ${sufficiency.facts} of the ${sufficiency.required} facts needed. Anything generated now would describe the shop rather than the product.`,
          remedy: sufficiency.missing.length
            ? `Add what is missing — ${sufficiency.missing.join(", ")} — or attach the manufacturer's page or specification, then continue.`
            : "Add what the product's specification says, then continue.",
        },
      ],
    };
  }

  if (context.run.seoRunId) {
    const [existing] = await db.select().from(seoResearchRuns).where(eq(seoResearchRuns.id, context.run.seoRunId));
    if (existing?.status === "running") return { kind: "wait", detail: "The content is being generated." };
    if (existing?.status === "completed") {
      return { kind: "done", detail: "The description, key features and search wording were prepared." };
    }
    if (existing?.status === "failed") {
      return {
        kind: "failed",
        failure: {
          code: PREPARATION_CODES.CONTENT_FAILED,
          message: "The content generator did not finish.",
          remedy: "Try again. The product's knowledge is untouched either way.",
        },
      };
    }
  }

  try {
    /*
     * One key per attempt at this step, so a retried job reuses the research
     * it already started instead of starting another version. The tick count
     * is part of it because a run that is continued with new sources, or
     * retried after the generator failed, has had its research link cleared
     * and must be able to generate again (D-122); within one attempt the tick
     * does not move before the link is stored.
     */
    const { run } = await runSeoPulse(context.actor, context.productId, {
      requestKey: `preparation:${context.run.id}:${context.run.ticks}`,
      fresh: false,
    });
    await db
      .update(productPreparationRuns)
      .set({ seoRunId: run.id, updatedAt: new Date() })
      .where(eq(productPreparationRuns.id, context.run.id));
    context.run = { ...context.run, seoRunId: run.id };
    if (run.status === "running") return { kind: "wait", detail: "The content is being generated." };
    if (run.status === "failed") {
      return {
        kind: "failed",
        failure: {
          code: PREPARATION_CODES.CONTENT_FAILED,
          message: "The content generator did not finish.",
          remedy: "Try again. The product's knowledge is untouched either way.",
        },
      };
    }
    return { kind: "done", detail: "The description, key features and search wording were prepared." };
  } catch (error) {
    // A generation provider that is busy or unavailable is not a failure of
    // the product: the knowledge is prepared, and the wording can be
    // generated later from the SEO Pulse panel.
    if (error instanceof SeoPulseError) {
      return {
        kind: "review",
        notes: [
          {
            code: PREPARATION_CODES.CONTENT_PROVIDER_UNAVAILABLE,
            message: `The content could not be generated just now: ${error.message}`,
            remedy: "The product's knowledge is prepared. Run SEO Pulse from the product's own panel when you are ready.",
          },
        ],
      };
    }
    throw error;
  }
}

/**
 * 6. The listing (D-122).
 *
 * The wording the previous step prepared is written into the fields where
 * nobody's writing is replaced: fields that are empty, and fields that still
 * hold SeoPulse's own unedited wording. A field a person wrote is left exactly
 * as it is and reported, so the editor can offer the newer version beside it.
 * Everything goes through `applyPreparedContent`, which checks ownership again
 * under the listing lock and records the change history like any other apply.
 *
 * Idempotent by construction: a field this step already wrote holds the
 * prepared wording, so a retry finds nothing different and writes nothing.
 */
async function stepListing(context: Context): Promise<Outcome> {
  const runId = context.run.seoRunId;
  if (!runId) {
    return { kind: "done", state: "skipped", detail: "There was no prepared content to add." };
  }

  let result: Awaited<ReturnType<typeof applyPreparedContent>>;
  try {
    result = await applyPreparedContent(context.actor, context.productId, runId);
  } catch (error) {
    if (error instanceof SeoPulseError && error.status === 409 && error.details?.changed) {
      // Somebody saved the listing while this step was deciding. Deciding
      // again against what they saved is the whole point of the re-check.
      return { kind: "wait", detail: "The listing changed; checking it again." };
    }
    if (error instanceof SeoPulseError) {
      // The research and the knowledge are prepared either way; only the
      // writing into the listing did not happen, and the editor still offers
      // every recommendation field by field.
      return {
        kind: "review",
        notes: [
          {
            code: PREPARATION_CODES.CONTENT_NOT_APPLIED,
            message: `The prepared content could not be added to the listing: ${error.message}`,
            remedy: "Nothing about the product's information was lost. Review the SeoPulse recommendations in Product content and SEO & search, then continue.",
          },
        ],
      };
    }
    throw error;
  }

  if (result.needsKnowledge) {
    return {
      kind: "review",
      notes: [
        {
          code: PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE,
          message: "Too little is established about this product to write customer content from.",
          remedy: "Add the manufacturer's page or specification, or the specifications by hand, then continue.",
        },
      ],
    };
  }

  const fields = { applied: result.applied, refreshed: result.refreshed, kept: result.kept, review: result.review };
  const parts = [
    result.applied.length ? `Added ${result.applied.join(", ")}.` : "",
    result.refreshed.length ? `Updated SeoPulse's earlier ${result.refreshed.join(", ")}.` : "",
    result.kept.length ? `Kept staff-written ${result.kept.join(", ")}.` : "",
    result.review.length ? `${result.review.join(", ")} ready for review.` : "",
    result.superseded ? "Newer SeoPulse recommendations exist; they are offered in the editor." : "",
  ].filter(Boolean);
  return {
    kind: "done",
    detail: parts.length ? parts.join(" ") : "The listing already holds the prepared content.",
    fields,
  };
}

/**
 * 7. Search.
 *
 * The search document rebuilds itself when a listing changes (migration 0014),
 * so in normal running there is nothing to wait for. This waits for the
 * listing to leave the rebuild queue when a bulk change has left a backlog,
 * and asks the drain worker to run; it degrades rather than failing, because a
 * lagging index is a delay, not a broken product.
 */
async function stepSearch(context: Context): Promise<Outcome> {
  const [queued] = await db
    .select({ productId: productSearchQueue.productId })
    .from(productSearchQueue)
    .where(eq(productSearchQueue.productId, context.productId));

  if (!queued) return { kind: "done", detail: "The listing is in the search index." };

  await enqueueUniquePending({ kind: "search.process_queue" });
  if (context.run.ticks >= MAX_TICKS - 1) {
    return { kind: "done", state: "degraded", detail: "The search index is still catching up; it will rebuild on its own." };
  }
  return { kind: "wait", detail: "Waiting for the search index." };
}

/**
 * 8. The page.
 *
 * The measurable checks, over the listing as it now stands. No score and no
 * prediction: a count of checks passed, which is what `lib/seo/readiness`
 * already reports everywhere else (D-081).
 */
async function stepPage(context: Context): Promise<Outcome> {
  const input = await loadPulseInput(context.productId);
  if (!input) {
    return {
      kind: "failed",
      failure: {
        code: PREPARATION_CODES.PRODUCT_REMOVED,
        message: "The product was removed while it was being prepared.",
        remedy: "Nothing to do.",
      },
    };
  }
  const seo = seoReadiness(input);
  const search = searchReadiness(input);
  return {
    kind: "done",
    state: seo.passed < seo.checks.length ? "degraded" : "done",
    detail: `SEO checks ${seo.passed} of ${seo.checks.length}; search checks ${search.passed} of ${search.checks.length}.`,
  };
}

/** Runs waiting on work that is no longer moving, for an operations view. */
export async function stalePreparationRuns(olderThanMinutes = 60) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  return db
    .select({
      id: productPreparationRuns.id,
      productId: productPreparationRuns.productId,
      stage: productPreparationRuns.stage,
      updatedAt: productPreparationRuns.updatedAt,
    })
    .from(productPreparationRuns)
    .where(
      and(
        inArray(productPreparationRuns.stage, ["IDENTIFYING", "FINDING_SOURCES", "RESEARCHING", "VERIFYING", "PREPARING_CONTENT", "PREPARING_SEARCH", "CHECKING_PAGE"]),
        sql`${productPreparationRuns.updatedAt} < ${cutoff.toISOString()}::timestamptz`,
      ),
    );
}
