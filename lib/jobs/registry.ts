import { deleteExpiredSessions } from "@/lib/auth/session";
import { releaseExpiredSkuReservations } from "@/lib/catalog/sku";
import { deliverQueuedNotifications } from "@/lib/notifications";
import { expireUnpaidOrders } from "@/lib/orders/expiry";
import { reconcilePayments } from "@/lib/payments/reconcile";
import { pruneRateLimits } from "@/lib/rate-limit";
import { pruneSearchLogs } from "@/lib/search/analytics";
import { processSearchQueue } from "@/lib/search/maintenance";
import { pruneFinishedJobs, type JobHandlers, type RecurringJob } from "./runner";

/**
 * Every kind of background job, and how often the recurring ones run.
 *
 * Each handler is idempotent on its own terms, which is what lets the runner
 * retry freely: expiry re-checks each order under a row lock, delivery claims
 * each message before sending, reconciliation goes through the guarded
 * capture path, and the pruning jobs delete by age.
 */
export const JOB_HANDLERS: JobHandlers = {
  "orders.expire_unpaid": async () => {
    const report = await expireUnpaidOrders();
    return { examined: report.examined, expired: report.expired.length };
  },
  "notifications.deliver": () => deliverQueuedNotifications(100),
  "payments.reconcile": () => reconcilePayments(),
  "search.process_queue": () => processSearchQueue(),
  "catalog.release_sku_holds": async () => ({ released: await releaseExpiredSkuReservations() }),
  "maintenance.prune": async () => {
    const rateLimits = await pruneRateLimits();
    await deleteExpiredSessions();
    const searchLogs = await pruneSearchLogs();
    const finishedJobs = await pruneFinishedJobs();
    return { rateLimits, searchLogs, finishedJobs };
  },
};

export const RECURRING_JOBS: RecurringJob[] = [
  { kind: "notifications.deliver", everyMinutes: 1 },
  { kind: "orders.expire_unpaid", everyMinutes: 2 },
  { kind: "payments.reconcile", everyMinutes: 10 },
  { kind: "search.process_queue", everyMinutes: 10 },
  { kind: "catalog.release_sku_holds", everyMinutes: 15 },
  { kind: "maintenance.prune", everyMinutes: 60 },
];
