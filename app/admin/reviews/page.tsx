import type { Metadata } from "next";
import Link from "next/link";
import { formatDate } from "@/lib/format";
import { listReviewsForModeration } from "@/lib/reviews";
import { StatusBadge } from "@/components/status-badge";
import { ModerationControls } from "./moderation-controls";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: "Reviews" };
export const dynamic = "force-dynamic";

const FILTERS = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;

function tone(status: string) {
  if (status === "approved") return "positive" as const;
  if (status === "rejected") return "negative" as const;
  return "neutral" as const;
}

export default async function AdminReviewsPage({
  searchParams,
}: PageProps<"/admin/reviews">) {
  const params = await searchParams;
  const status =
    typeof params.status === "string" &&
    FILTERS.some((filter) => filter.value === params.status)
      ? params.status
      : "pending";

  const user = await requireAdminPage("reviews.moderate");
  const rows = await listReviewsForModeration(user, { status });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Operations
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Reviews</h1>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          Every review is written by someone whose order was delivered, and
          none is public until it is approved here. Rejecting one removes it
          from the product page and from the average.
        </p>
      </div>

      <nav aria-label="Filter by status">
        <ul className="inline-flex flex-wrap gap-1 rounded-control border border-blue-300 bg-paper-raised p-1">
          {FILTERS.map((filter) => (
            <li key={filter.value}>
              <Link
                href={`/admin/reviews?status=${filter.value}`}
                aria-current={status === filter.value ? "page" : undefined}
                className={`inline-flex min-h-9 items-center rounded-control px-3 text-meta transition-colors ${
                  status === filter.value
                    ? "bg-paper font-medium text-ink shadow-[var(--shadow-raise)]"
                    : "text-ink/70 hover:bg-paper/70 hover:text-ink"
                }`}
              >
                {filter.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {rows.length === 0 ? (
        <div className="surface-paper rounded-card border border-blue-300 p-8">
          <p className="text-body text-ink">Nothing here.</p>
          <p className="mt-2 text-meta text-ink/70">
            Reviews appear once a delivered customer writes one.
          </p>
        </div>
      ) : (
        <ul className="border-t border-blue-300">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap gap-x-6 gap-y-3 border-b border-blue-300 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-body text-ink">
                  <span aria-hidden="true">{"★".repeat(row.rating)}</span>
                  <span className="sr-only">{row.rating} out of 5</span>
                  {row.title ? ` — ${row.title}` : ""}
                </p>
                <p className="mt-1 text-meta text-ink/70">
                  <Link
                    href={`/products/${row.productSlug}`}
                    className="hover:underline"
                  >
                    {row.productTitle}
                  </Link>{" "}
                  · {row.authorEmail} · {formatDate(row.createdAt)}
                </p>
                {row.body ? (
                  <p className="mt-2 max-w-[70ch] whitespace-pre-wrap text-body text-ink/80">
                    {row.body}
                  </p>
                ) : null}
              </div>

              <div className="flex min-w-[200px] flex-col gap-3">
                <StatusBadge tone={tone(row.status)}>{row.status}</StatusBadge>
                <ModerationControls reviewId={row.id} status={row.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
