"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import type { ReadinessCheck } from "@/lib/catalog";

const STATUSES = [
  { value: "preorder_open", label: "Preorder open — shoppers can order now" },
  { value: "in_stock", label: "In stock — ships from stock on hand" },
  { value: "coming_soon", label: "Coming soon — visible, not yet orderable" },
  { value: "preorder_closed", label: "Preorder closed — window has ended" },
] as const;

/**
 * The last step. The checklist is computed on the server and re-checked there
 * when Publish is pressed, so this panel reports the rule rather than being it.
 */
export function PublishPanel({
  productId,
  slug,
  status,
  checks,
  canPublish,
}: {
  productId: string;
  slug: string;
  status: string;
  checks: ReadinessCheck[];
  canPublish: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);

    const form = new FormData(event.currentTarget);

    const response = await fetch(
      `/api/admin/products/${productId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: form.get("status") }),
      },
    );

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setMessage("Published. It is live on the storefront now.");
    router.refresh();
  }

  const blocking = checks.filter((check) => check.required && !check.passed);
  const advisory = checks.filter((check) => !check.required && !check.passed);

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <section>
        <h2 className="font-display text-h2 text-ink">Before it goes live</h2>

        <ul className="mt-4 border-t border-blue-300">
          {checks.map((check) => (
            <li
              key={check.id}
              className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-blue-300 py-3"
            >
              <span
                aria-hidden="true"
                className={
                  check.passed
                    ? "text-transit-green-text"
                    : check.required
                      ? "text-stamp-red-text"
                      : "text-brass-text"
                }
              >
                {check.passed ? "✓" : check.required ? "✕" : "!"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-body text-ink">
                  {check.label}
                  <span className="sr-only">
                    {check.passed
                      ? " — done"
                      : check.required
                        ? " — required, not done"
                        : " — recommended, not done"}
                  </span>
                </p>
                {!check.passed ? (
                  <p className="mt-1 text-meta text-ink/70">{check.hint}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="font-display text-h2 text-ink">Preview</h2>
        <p className="mt-2 text-meta text-ink/70">
          The product page as it will look. A draft is only visible to staff, so
          this opens the real page once it is published.
        </p>
        <a
          href={`/products/${slug}`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 text-body text-blue-600"
        >
          Open /products/{slug}
        </a>
      </section>

      <form onSubmit={publish} className="flex flex-col gap-4">
        <h2 className="font-display text-h2 text-ink">Publish</h2>

        <div className="flex flex-col gap-2">
          <label htmlFor="status" className="text-meta font-medium text-ink">
            Publish as
          </label>
          <select
            id="status"
            name="status"
            defaultValue={
              STATUSES.some((option) => option.value === status)
                ? status
                : "preorder_open"
            }
            className="min-h-11 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
          >
            {STATUSES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {blocking.length > 0 ? (
          <p className="border border-stamp-red p-3 text-meta text-ink">
            {blocking.length} thing{blocking.length === 1 ? "" : "s"} above must
            be done first. The server refuses a publish either way, so this
            button stays off until they are.
          </p>
        ) : advisory.length > 0 ? (
          <p className="border border-brass p-3 text-meta text-ink">
            You can publish, but {advisory.length} recommended item
            {advisory.length === 1 ? " is" : "s are"} still missing.
          </p>
        ) : null}

        <div aria-live="polite" className="flex flex-col gap-1">
          {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
          {message ? (
            <p className="text-meta text-transit-green-text">{message}</p>
          ) : null}
        </div>

        <div>
          <Button type="submit" disabled={pending || !canPublish}>
            {pending ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </form>
    </div>
  );
}
