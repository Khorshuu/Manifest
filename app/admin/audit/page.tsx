import type { Metadata } from "next";
import Link from "next/link";
import {
  countAuditEntries,
  listAuditActions,
  listAuditEntries,
} from "@/lib/admin";
import { getCurrentUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** Renders a before/after value compactly, without pretending JSON is prose. */
function Detail({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;

  return (
    <div>
      <span className="text-meta text-ink/50">{label}</span>
      <pre className="mt-1 whitespace-pre-wrap font-mono text-meta text-ink/70">
        {JSON.stringify(value)}
      </pre>
    </div>
  );
}

export default async function AdminAuditPage({
  searchParams,
}: PageProps<"/admin/audit">) {
  const params = await searchParams;
  const action = typeof params.action === "string" ? params.action : undefined;
  const page = Math.max(1, Number(params.page) || 1);

  const user = await getCurrentUser();

  const [entries, actions, total] = await Promise.all([
    listAuditEntries(user, {
      action,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    listAuditActions(user),
    countAuditEntries(user, { action }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-meta text-blue-400">Operations</p>
        <h1 className="mt-2 font-display text-h1 text-ink">Audit log</h1>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          Every administrative change, with who made it. This log is written to
          in the same transaction as the change and is never edited.
        </p>
      </div>

      {actions.length > 0 ? (
        <nav aria-label="Filter by action">
          <ul className="flex flex-wrap gap-2">
            <li>
              <Link
                href="/admin/audit"
                aria-current={action ? undefined : "page"}
                className={`inline-flex min-h-11 items-center rounded-control border px-3 text-meta ${
                  action ? "border-blue-300 text-ink" : "border-blue-600 text-blue-600"
                }`}
              >
                All
              </Link>
            </li>
            {actions.map((name) => (
              <li key={name}>
                <Link
                  href={`/admin/audit?action=${name}`}
                  aria-current={action === name ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-control border px-3 text-meta ${
                    action === name
                      ? "border-blue-600 text-blue-600"
                      : "border-blue-300 text-ink"
                  }`}
                >
                  {name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {entries.length === 0 ? (
        <div className="border border-blue-300 p-8">
          <p className="text-body text-ink">Nothing recorded yet.</p>
          <p className="mt-2 text-meta text-ink/70">
            Entries appear here as soon as an administrative change is made.
          </p>
        </div>
      ) : (
        <ul className="border-t border-blue-300">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap gap-x-6 gap-y-2 border-b border-blue-300 py-4"
            >
              <div className="min-w-[220px] flex-1">
                <p className="text-body text-ink">{entry.action}</p>
                <p className="text-meta text-ink/60">
                  {entry.entityType} · {entry.actorEmail}
                </p>
              </div>

              <div className="flex min-w-[260px] flex-1 flex-col gap-2">
                <Detail label="Before" value={entry.beforeJson} />
                <Detail label="After" value={entry.afterJson} />
              </div>

              <p className="text-meta text-ink/70">
                {formatDate(entry.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 ? (
        <nav aria-label="Pagination" className="flex gap-3">
          {page > 1 ? (
            <Link
              href={`/admin/audit?${action ? `action=${action}&` : ""}page=${page - 1}`}
              className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
            >
              Previous
            </Link>
          ) : null}
          <span className="inline-flex min-h-11 items-center text-meta text-ink/70">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link
              href={`/admin/audit?${action ? `action=${action}&` : ""}page=${page + 1}`}
              className="inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
