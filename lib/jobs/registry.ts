import { deleteExpiredSessions } from "@/lib/auth/session";
import { pruneUnreachableGuestCarts } from "@/lib/cart";
import { applyPublishSchedule } from "@/lib/catalog/schedule";
import { releaseExpiredSkuReservations } from "@/lib/catalog/sku";
import { deliverQueuedNotifications } from "@/lib/notifications";
import { mediaCoverage, registerExistingMedia, sweepUnreferencedMedia } from "@/lib/media/registry";
import { expireUnpaidOrders } from "@/lib/orders/expiry";
import { reconcilePayments } from "@/lib/payments/reconcile";
import { pruneRateLimits } from "@/lib/rate-limit";
import { advancePreparation } from "@/lib/preparation";
import { runEnrichment } from "@/lib/pkb/enrichment";
import { runKnowledgeSync } from "@/lib/pkb/maintenance";
import { getMediaProvider } from "@/lib/providers/media";
import { pruneSearchLogs } from "@/lib/search/analytics";
import {
  pruneSearchConsoleMetrics,
  runSearchConsoleSync,
  scheduledSearchConsoleSync,
} from "@/lib/search-console/sync";
import { completeQueuedResearch } from "@/lib/seo-pulse/service";
import { processSearchQueue } from "@/lib/search/maintenance";
import { pruneFinishedJobs, type JobHandlers, type RecurringJob } from "./runner";

/**
 * Every kind of background job, and how often the recurring ones run.
 *
 * Each handler is idempotent on its own terms, which is what lets the runner
 * retry freely: expiry re-checks each order under a row lock, delivery claims
 * each message before sending, reconciliation goes through the guarded
 * capture path, the pruning jobs delete by age, and the media sweep claims
 * each file by deleting its row under the same reference check.
 */
export const JOB_HANDLERS: JobHandlers = {
  "orders.expire_unpaid": async () => {
    const report = await expireUnpaidOrders();
    return { examined: report.examined, expired: report.expired.length };
  },
  "notifications.deliver": () => deliverQueuedNotifications(100),
  "payments.reconcile": () => reconcilePayments(),
  // Bounded by rows and by time, and continues itself while it is making
  // progress, so a whole-catalogue rebuild drains across several runs instead
  // of inside one request (risk R-12). It is handed its own job id so the
  // successor it enqueues is not refused by its own running row.
  "search.process_queue": (_payload, context) => processSearchQueue({ jobId: context.jobId }),
  // Research that calls an external provider, off the admin request path. A
  // run that is no longer running is left untouched, so a retry is safe.
  "seo.research_product": (payload) => completeQueuedResearch(String(payload.runId)),
  // Idempotent: a listing is re-read from its current state under its lock.
  "pkb.sync_listings": () => runKnowledgeSync(),
  // One step of a product preparation run, then the run either finishes, stops
  // for a person, or schedules its own next wake-up. Idempotent: a step that
  // has completed is recorded on the run and never run again, and a finished
  // or cancelled run is left exactly as it is.
  "catalog.prepare_product": (payload) => advancePreparation(String(payload.runId)),
  // Retrieval is slow and must not run on a staff request; a finished run is
  // returned unchanged, so a retry cannot propose the same claims twice.
  "pkb.enrich_product": (payload) => runEnrichment(String(payload.runId)),
  // Idempotent by storage: a measurement is keyed on property, day, dimension,
  // page and query, so re-reading a window updates rows instead of adding any.
  // A finished sync is returned unchanged, so a retry cannot fetch twice.
  "seo.search_console_sync": (payload) => runSearchConsoleSync(String(payload.syncId)),
  // Asks for a sync when there is a newer window to read. With no Search
  // Console configured it reports that and does nothing.
  "seo.search_console_schedule": () => scheduledSearchConsoleSync(),
  "catalog.release_sku_holds": async () => ({ released: await releaseExpiredSkuReservations() }),
  "maintenance.prune": async () => {
    const rateLimits = await pruneRateLimits();
    await deleteExpiredSessions();
    const searchLogs = await pruneSearchLogs();
    const searchConsoleMetrics = await pruneSearchConsoleMetrics();
    const finishedJobs = await pruneFinishedJobs();
    const guestCarts = await pruneUnreachableGuestCarts();
    return { rateLimits, searchLogs, searchConsoleMetrics, finishedJobs, guestCarts };
  },
  // Reconciles, then sweeps, then reports what the registry covers (risk R-11).
  //
  // Reconciling first is deliberate and is also what makes it safe: a row it
  // writes is created now, so the sweep's grace period puts that file out of
  // reach of this same run, and the file is referenced at the moment it is
  // recorded. Registering is confined to addresses the provider says it stores,
  // so an illustration shipped with the site never gains a row and so never
  // becomes something the sweep may delete.
  //
  // Both halves are idempotent: registration conflicts on the key, and the
  // sweep claims each file by deleting its row under the same reference check.
  "media.sweep_unreferenced": async () => {
    const provider = getMediaProvider();
    const reconciled = await registerExistingMedia(provider);
    const swept = await sweepUnreferencedMedia(provider);
    const coverage = await mediaCoverage(provider);
    return {
      ...swept,
      registeredNow: reconciled.registered,
      measuredNow: reconciled.measured,
      referenced: coverage.referenced,
      registered: coverage.registered,
      unregisteredOwned: coverage.unregisteredOwned,
      foreignOrStatic: coverage.foreignOrStatic,
      registeredWithoutDimensions: coverage.registeredWithoutDimensions,
    };
  },
  "catalog.apply_publish_schedule": () => applyPublishSchedule(),
};

export const RECURRING_JOBS: RecurringJob[] = [
  { kind: "notifications.deliver", everyMinutes: 1 },
  { kind: "orders.expire_unpaid", everyMinutes: 2 },
  { kind: "payments.reconcile", everyMinutes: 10 },
  { kind: "search.process_queue", everyMinutes: 10 },
  { kind: "pkb.sync_listings", everyMinutes: 5 },
  { kind: "catalog.release_sku_holds", everyMinutes: 15 },
  { kind: "catalog.apply_publish_schedule", everyMinutes: 5 },
  // Search Console reports whole days and lags behind by a couple of them, so
  // asking twice a day is as often as there is anything new to read.
  { kind: "seo.search_console_schedule", everyMinutes: 720 },
  { kind: "maintenance.prune", everyMinutes: 60 },
  { kind: "media.sweep_unreferenced", everyMinutes: 60 },
];
