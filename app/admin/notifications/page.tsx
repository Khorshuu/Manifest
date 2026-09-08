import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { countOutboxByStatus, listOutbox } from "@/lib/notifications";
import { StatusBadge } from "@/components/status-badge";
import { DrainButton } from "./drain-button";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

function tone(status: string) {
  if (status === "sent") return "positive" as const;
  if (status === "failed") return "negative" as const;
  return "neutral" as const;
}

export default async function AdminNotificationsPage() {
  const user = await getCurrentUser();

  const [rows, counts] = await Promise.all([
    listOutbox(user),
    countOutboxByStatus(user),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-meta text-blue-400">Operations</p>
        <h1 className="mt-2 font-display text-h1 text-ink">Notifications</h1>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          Every message the shop has for a customer. A message is written here
          in the same transaction as the order change that caused it, then
          delivered separately, so nothing is lost if delivery fails.
        </p>
      </div>

      {/* Said plainly, because a "sent" row here is not proof a customer
          received anything while the mock provider is configured. */}
      <p className="border border-brass bg-brass/10 p-4 text-meta text-ink">
        No email or SMS provider is connected. Messages are composed and
        recorded, and delivery goes to the development provider, which sends
        nothing to anyone.
      </p>

      <dl className="grid grid-cols-1 gap-px border border-blue-300 bg-blue-300 sm:grid-cols-3">
        {(
          [
            ["Queued", counts.queued],
            ["Sent", counts.sent],
            ["Failed", counts.failed],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="min-w-0 bg-paper p-4">
            <dt className="text-meta text-ink/70">{label}</dt>
            <dd className="mt-1 font-display text-h2 text-ink tabular-nums">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <DrainButton queued={counts.queued} />

      {rows.length === 0 ? (
        <div className="border border-blue-300 p-8">
          <p className="text-body text-ink">Nothing to send yet.</p>
          <p className="mt-2 text-meta text-ink/70">
            Messages appear here as soon as an order is placed or moves on.
          </p>
        </div>
      ) : (
        <ul className="border-t border-blue-300">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap gap-x-6 gap-y-2 border-b border-blue-300 py-4"
            >
              <div className="min-w-[240px] flex-1">
                <p className="text-body text-ink">{row.subject}</p>
                <p className="text-meta text-ink/60">
                  {row.recipient} · {row.channel} · {row.template}
                </p>
                {row.error ? (
                  <p className="mt-1 text-meta text-stamp-red">{row.error}</p>
                ) : null}
              </div>

              <div className="min-w-[140px]">
                <StatusBadge tone={tone(row.status)}>{row.status}</StatusBadge>
              </div>

              <p className="min-w-[180px] text-meta text-ink/70">
                {row.orderNumber ?? "—"}
                <br />
                {formatDate(row.sentAt ?? row.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
