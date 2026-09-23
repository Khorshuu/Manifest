"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

export type JobProblem = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date | string;
};

/**
 * Jobs that are waiting or have given up, with a retry for the ones that have.
 *
 * The error text is staff-facing and can carry a provider's words, so it is
 * shown here and nowhere a customer can reach. Retrying needs
 * `settings.manage`; the button is hidden without it and the API refuses it
 * regardless.
 */
export function JobFailures({ problems, mayRetry }: { problems: JobProblem[]; mayRetry: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function retry(jobId: string) {
    setPending(jobId);
    setError(null);
    const response = await fetch("/api/admin/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    setPending(null);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? "That job could not be retried.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="border-b border-line text-left text-[0.7rem] uppercase tracking-wide text-ink/55">
            <tr>
              <th className="px-4 py-3">Job</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Reason</th>
              {mayRetry ? <th className="px-4 py-3">Retry</th> : null}
            </tr>
          </thead>
          <tbody>
            {problems.map((problem) => (
              <tr key={problem.id} className="border-b border-line/60 align-top last:border-0">
                <td className="px-4 py-3 text-ink">{problem.kind}</td>
                <td className="px-4 py-3 text-ink/70">{problem.status}</td>
                <td className="px-4 py-3 tabular-nums text-ink/70">{problem.attempts}</td>
                <td className="px-4 py-3 text-ink/70">{problem.lastError ?? "—"}</td>
                {mayRetry ? (
                  <td className="px-4 py-3">
                    {problem.status === "dead" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={pending === problem.id}
                        onClick={() => retry(problem.id)}
                      >
                        {pending === problem.id ? "Queueing…" : "Retry"}
                      </Button>
                    ) : (
                      <span className="text-ink/55">still queued</span>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <p className="text-sm text-stamp-red-text">{error}</p> : null}
    </div>
  );
}
