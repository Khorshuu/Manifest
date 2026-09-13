import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { getInbox, type InboxKind } from "@/lib/admin";
import { can } from "@/lib/auth";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { formatDate, formatShortDate } from "@/lib/format";
import { countOutboxByStatus, listOutbox } from "@/lib/notifications";
import { DrainButton } from "./drain-button";
import { MarkReadButton } from "./mark-read-button";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

const KIND_LABELS: Record<InboxKind, string> = {
  new_order: "Order",
  awaiting_payment: "Payment",
  cancellation: "Cancellation",
  failed_message: "Message failed",
  stock: "Stock",
  new_customer: "Customer",
  pending_review: "Review",
};

function messageTone(status: string) {
  if (status === "sent") return "positive" as const;
  if (status === "failed") return "negative" as const;
  return "neutral" as const;
}

/**
 * Two things share this page. The inbox is what staff should know about —
 * new orders, orders stuck unpaid, cancellation requests, failed messages,
 * stock running out, new customers, reviews waiting — each read live from the
 * record itself. Customer messages is the outbox of email/SMS the shop sends.
 */
export default async function AdminNotificationsPage({
  searchParams,
}: PageProps<"/admin/notifications">) {
  const user = await requireAdminPage("notifications.view");
  const params = await searchParams;
  const tab = params.tab === "messages" ? "messages" : "inbox";
  const filter =
    params.show === "unread" || params.show === "read" || params.show === "action"
      ? params.show
      : "all";
  const messageStatus =
    params.status === "queued" || params.status === "sent" || params.status === "failed"
      ? params.status
      : null;

  const [inbox, counts] = await Promise.all([getInbox(user), countOutboxByStatus(user)]);
  const rows = tab === "messages" ? await listOutbox(user) : [];
  const messages = messageStatus ? rows.filter((row) => row.status === messageStatus) : rows;

  const items = inbox.items.filter((item) =>
    filter === "unread"
      ? item.unread
      : filter === "read"
        ? !item.unread
        : filter === "action"
          ? item.needsAction
          : true,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="admin-h1">Notifications</h1>
          <p className="mt-0.5 text-meta text-ink/70">
            {inbox.unread} unread · {inbox.needsAction} need action
          </p>
        </div>
        <nav aria-label="Notification views" className="flex gap-1.5">
          <Link href="/admin/notifications" aria-current={tab === "inbox" ? "true" : undefined} className="admin-chip">
            Inbox
            {inbox.unread > 0 ? (
              <span className="ml-1 rounded-full bg-stamp-red-text px-1.5 text-[0.6875rem] font-bold text-paper">{inbox.unread}</span>
            ) : null}
          </Link>
          <Link href="/admin/notifications?tab=messages" aria-current={tab === "messages" ? "true" : undefined} className="admin-chip">
            Customer messages
            {counts.failed > 0 ? (
              <span className="ml-1 rounded-full bg-stamp-red-text px-1.5 text-[0.6875rem] font-bold text-paper">{counts.failed}</span>
            ) : null}
          </Link>
        </nav>
      </div>

      {tab === "inbox" ? (
        <section className="admin-card p-0">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-blue-200 px-3 py-2.5">
            {(
              [
                ["all", "All"],
                ["unread", "Unread"],
                ["action", "Needs action"],
                ["read", "Read"],
              ] as const
            ).map(([value, label]) => (
              <Link
                key={value}
                href={value === "all" ? "/admin/notifications" : `/admin/notifications?show=${value}`}
                aria-current={filter === value ? "true" : undefined}
                className="admin-chip"
              >
                {label}
              </Link>
            ))}
            <span className="ml-auto">
              <MarkReadButton disabled={inbox.unread === 0} />
            </span>
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-6 text-meta text-ink/70">
              {filter === "unread" ? "You are all caught up." : "Nothing here in the last 30 days."}
            </p>
          ) : (
            <ul className="divide-y divide-blue-100">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className={`flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-blue-50/60 ${item.unread ? "bg-blue-50/40" : ""}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${item.unread ? "bg-blue-600" : "bg-transparent"}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className={`text-meta text-ink ${item.unread ? "font-semibold" : ""}`}>{item.title}</span>
                        {item.needsAction ? <StatusBadge tone="warning">Needs action</StatusBadge> : null}
                      </span>
                      <span className="block truncate text-[0.75rem] text-ink/70">
                        {KIND_LABELS[item.kind]} · {item.detail}
                      </span>
                    </span>
                    <span className="shrink-0 text-[0.75rem] text-ink/70">
                      {item.kind === "stock" ? "now" : formatShortDate(item.at)}
                    </span>
                    {item.unread ? <span className="sr-only">(unread)</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          {/* Said plainly, because a "sent" row here is not proof a customer
              received anything while the mock provider is configured. */}
          <p className="rounded-card border border-brass bg-brass/10 px-3 py-2 text-meta text-ink">
            No email or SMS provider is connected. Messages are composed and
            recorded, and delivery goes to the development provider, which sends
            nothing to anyone.
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                [null, `All (${counts.queued + counts.sent + counts.failed})`],
                ["queued", `Queued (${counts.queued})`],
                ["sent", `Sent (${counts.sent})`],
                ["failed", `Failed (${counts.failed})`],
              ] as const
            ).map(([value, label]) => (
              <Link
                key={label}
                href={`/admin/notifications?tab=messages${value ? `&status=${value}` : ""}`}
                aria-current={messageStatus === value ? "true" : undefined}
                className="admin-chip"
              >
                {label}
              </Link>
            ))}
            {can(user, "notifications.view") ? (
              <span className="ml-auto">
                <DrainButton queued={counts.queued} />
              </span>
            ) : null}
          </div>

          {messages.length === 0 ? (
            <div className="admin-card">
              <p className="text-meta text-ink">Nothing here.</p>
            </div>
          ) : (
            <>
            {/* Narrow screens: one card per message. */}
            <ul className="flex flex-col gap-2 md:hidden" aria-label="Messages">
              {messages.map((row) => (
                <li key={row.id} className="admin-card flex flex-col gap-1.5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 font-semibold text-ink [overflow-wrap:anywhere]">
                      {row.subject}
                    </p>
                    <StatusBadge tone={messageTone(row.status)}>{row.status}</StatusBadge>
                  </div>
                  <p className="text-[0.75rem] text-ink/70 [overflow-wrap:anywhere]">
                    {row.recipient}
                  </p>
                  <p className="text-[0.75rem] text-ink/70">
                    {row.channel} · {row.template}
                    {row.orderNumber ? ` · ${row.orderNumber}` : ""}
                  </p>
                  {row.error ? (
                    <p className="text-[0.75rem] text-stamp-red-text [overflow-wrap:anywhere]">
                      {row.error}
                    </p>
                  ) : null}
                  <p className="text-[0.75rem] text-ink/70">
                    {formatDate(row.sentAt ?? row.createdAt)}
                  </p>
                </li>
              ))}
            </ul>

            <div className="admin-card relative hidden overflow-x-auto p-0 md:block">
              <table className="admin-table min-w-[760px]">
                <thead>
                  <tr>
                    <th scope="col">Message</th>
                    <th scope="col">Recipient</th>
                    <th scope="col">Order</th>
                    <th scope="col">Status</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {messages.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span className="block text-ink">{row.subject}</span>
                        <span className="block text-ink/70">{row.channel} · {row.template}</span>
                        {row.error ? <span className="block text-stamp-red-text">{row.error}</span> : null}
                      </td>
                      <td className="max-w-[14rem] truncate text-ink/75">{row.recipient}</td>
                      <td className="tabular-nums text-ink/75">{row.orderNumber ?? "—"}</td>
                      <td><StatusBadge tone={messageTone(row.status)}>{row.status}</StatusBadge></td>
                      <td className="whitespace-nowrap text-ink/70">{formatDate(row.sentAt ?? row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
