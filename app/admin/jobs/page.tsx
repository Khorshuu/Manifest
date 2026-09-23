import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { can } from "@/lib/auth/authorize";
import { RECURRING_JOBS } from "@/lib/jobs/registry";
import { jobSummary } from "@/lib/jobs/runner";
import { resolveRecurringJobs, schedulerHealth } from "@/lib/jobs/schedule";
import { EmptyState } from "@/components/empty-state";
import { JobFailures } from "./failures";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Background work" };

/** A job result, rendered as the sentence it is rather than as JSON. */
function describe(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const parts = Object.entries(result as Record<string, unknown>)
    .filter(([, value]) => typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    .map(([key, value]) => `${key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}: ${value}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function when(at: Date | null): string {
  if (!at) return "—";
  return at.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * What the background work has been doing.
 *
 * Every scheduled job already recorded what it did — how many files the media
 * sweep reclaimed, how many listings are left to reindex, what the prune
 * removed — into `jobs.result`, and until Stage 7 nothing read it back. An
 * operator could see that the scheduler was running and that something had
 * died, and nothing in between; anything else meant querying the database.
 *
 * Reading needs `notifications.view`, the permission that already gates the
 * operational screens. Retrying a dead job needs `settings.manage`, which the
 * API checks again.
 */
export default async function AdminJobsPage() {
  const user = await requireAdminPage("notifications.view");
  const summary = await jobSummary(user);
  const schedule = resolveRecurringJobs(RECURRING_JOBS);
  const health = await schedulerHealth(schedule.jobs);

  const byKind = new Map(summary.lastRuns.map((run) => [run.kind, run]));
  const intervals = new Map(schedule.jobs.map((job) => [job.kind, job.everyMinutes]));

  const totals = summary.counts.reduce<Record<string, number>>((all, row) => {
    all[row.status] = (all[row.status] ?? 0) + Number(row.total);
    return all;
  }, {});

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="text-[0.75rem] uppercase tracking-wide text-ink/55">Operations</p>
        <h1 className="font-display text-2xl text-ink">Background work</h1>
        <p className="max-w-2xl text-sm text-ink/70">
          Everything the shop does away from a request: delivering messages, expiring unpaid orders, rebuilding the
          search index, sweeping unused files, reading Search Console. Each row is the last time that job finished
          and what it reported.
        </p>
      </header>

      {health.stale ? (
        <div className="rounded-xl border border-stamp-red/40 bg-stamp-red/5 p-4 text-sm">
          <strong className="text-stamp-red-text">Scheduled jobs are not running.</strong>{" "}
          {health.lastRunAt ? `The scheduler last called in at ${when(health.lastRunAt)}.` : "The scheduler has never called in."}{" "}
          Nothing below will change until whatever calls /api/cron/jobs does so at least every{" "}
          {health.expectedEveryMinutes} minute(s).
        </div>
      ) : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(["queued", "running", "succeeded", "failed", "dead"] as const).map((status) => (
          <div key={status} className="rounded-xl border border-line bg-surface p-4">
            <p className="text-[0.7rem] uppercase tracking-wide text-ink/55">{status}</p>
            <p className="font-display text-2xl text-ink">{(totals[status] ?? 0).toLocaleString("en-GB")}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg text-ink">Each job, last time it ran</h2>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-line text-left text-[0.7rem] uppercase tracking-wide text-ink/55">
              <tr>
                <th className="px-4 py-3">Job</th>
                <th className="px-4 py-3">Every</th>
                <th className="px-4 py-3">Last finished</th>
                <th className="px-4 py-3">What it reported</th>
              </tr>
            </thead>
            <tbody>
              {[...new Set([...intervals.keys(), ...byKind.keys()])].sort().map((kind) => {
                const run = byKind.get(kind);
                const every = intervals.get(kind);
                return (
                  <tr key={kind} className="border-b border-line/60 align-top last:border-0">
                    <td className="px-4 py-3 text-ink">{kind}</td>
                    <td className="px-4 py-3 text-ink/70">
                      {every ? `${every} min` : schedule.disabled.includes(kind) ? "switched off" : "on demand"}
                    </td>
                    <td className="px-4 py-3 text-ink/70">
                      {run ? (
                        <>
                          {when(run.finishedAt)}
                          {run.status !== "succeeded" ? (
                            <span className="text-stamp-red-text"> — {run.status}</span>
                          ) : null}
                        </>
                      ) : (
                        "never"
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink/70">
                      {run?.lastError ? (
                        <span className="text-stamp-red-text">{run.lastError}</span>
                      ) : (
                        (run && describe(run.result)) ?? "nothing to report"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {schedule.problems.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-stamp-red-text">
            {schedule.problems.map((problem) => (
              <li key={problem}>JOB_SCHEDULE: {problem}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg text-ink">Waiting or failed</h2>
        {summary.problems.length === 0 ? (
          <EmptyState title="Nothing has failed" body="No job is dead and none has recorded an error." />
        ) : (
          <JobFailures problems={summary.problems} mayRetry={can(user, "settings.manage")} />
        )}
      </section>
    </div>
  );
}
