import type { Metadata } from "next";
import Link from "next/link";
import {
  countAuditEntries,
  decodeAuditCursor,
  listAuditActions,
  listAuditPage,
} from "@/lib/admin";
import { formatDate } from "@/lib/format";
import { requireAdminPage } from "@/lib/auth/admin-page";

/*
 * Cache Components (DECISIONS.md D-054): live staff data, read per request.
 */
export const instant = false;

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

/** Renders a before/after value compactly, without pretending JSON is prose. */
function Detail({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;

  return (
    <div>
      <span className="text-meta text-ink/70">{label}</span>
      {/* A recorded value is JSON, and JSON has no spaces to break at: without
          `anywhere` a long one-line object pushes the whole page sideways at
          every width. */}
      <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-meta text-ink/70">
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
  const after = decodeAuditCursor(params.after);
  const before = after ? undefined : decodeAuditCursor(params.before);

  const user = await requireAdminPage("audit.view");

  /*
   * Newer and Older by keyset (PRODUCTION-READINESS 14.1): the log only grows,
   * and a numbered page deep into it cost a scan of every entry before it.
   */
  const [{ entries, nextCursor, previousCursor }, actions, total] = await Promise.all([
    listAuditPage(user, { action, limit: PAGE_SIZE, after, before }),
    listAuditActions(user),
    countAuditEntries(user, { action }),
  ]);

  const pageHref = (cursor: { after?: string; before?: string }) => {
    const query = new URLSearchParams();
    if (action) query.set("action", action);
    if (cursor.after) query.set("after", cursor.after);
    if (cursor.before) query.set("before", cursor.before);
    return `/admin/audit?${query.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Operations
        </p>
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
        <div className="surface-paper rounded-card border border-blue-300 p-8">
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
                <p className="text-meta text-ink/70">
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

      {previousCursor || nextCursor ? (
        <nav aria-label="Pagination" className="flex flex-wrap items-center gap-3">
          {previousCursor ? (
            <Link
              href={pageHref({ before: previousCursor })}
              className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
            >
              Newer
            </Link>
          ) : null}
          <span className="inline-flex min-h-11 items-center text-meta text-ink/70">
            {total.toLocaleString("en-GB")} {total === 1 ? "entry" : "entries"}
          </span>
          {nextCursor ? (
            <Link
              href={pageHref({ after: nextCursor })}
              className="inline-flex items-center justify-center gap-2 rounded-control font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 min-h-11 px-4 text-body border border-blue-300 bg-paper text-blue-600 hover:border-blue-500 hover:bg-blue-50 hover:shadow-[var(--shadow-raise)]"
            >
              Older
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
