"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { FormStatus } from "./editor-parts";

export type KeywordTerm = { term: string; status: "approved" | "suggested" | "unknown" };

const WORDING: Record<KeywordTerm["status"], string> = {
  approved: "an approved alias",
  suggested: "waiting for a decision",
  unknown: "a search term only",
};

/**
 * A listing's recorded search terms, and what each has become (D-105).
 *
 * The button proposes the terms that are still only search terms as *suggested*
 * aliases. It approves nothing: someone with the authority over search
 * vocabulary decides each one afterwards, which is the same two-step path every
 * other alias takes. The search terms stay on the listing either way.
 */
export function KeywordAliasesPanel({ productId, terms }: { productId: string; terms: KeywordTerm[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unmigrated = terms.filter((term) => term.status === "unknown");

  async function propose() {
    setPending(true);
    setError(null);
    setMessage(null);
    const response = await fetch(`/api/admin/products/${productId}/keyword-aliases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? "That did not work.");
      return;
    }
    const body = (await response.json()) as { proposed: string[]; skipped: string[] };
    setMessage(
      body.proposed.length === 0
        ? "Nothing new to propose — every term has already been decided on."
        : `Proposed ${body.proposed.length} term(s) as aliases. Each one still needs approving.`,
    );
    router.refresh();
  }

  if (terms.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg text-ink">Search terms recorded on this listing</h2>
        <p className="max-w-2xl text-sm text-ink/70">
          These feed the shop&rsquo;s own search. They are this listing&rsquo;s wording rather than facts about the
          product, so they stay here — but a term that is genuinely another name for the product can become one the
          knowledge base knows, once somebody approves it.
        </p>
      </div>

      <ul className="flex flex-col gap-1 text-sm">
        {terms.map((term) => (
          <li key={term.term} className="flex flex-wrap items-baseline gap-2">
            <span className="text-ink">{term.term}</span>
            <span className="text-ink/60">— {WORDING[term.status]}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="button" variant="secondary" disabled={pending || unmigrated.length === 0} onClick={propose}>
          {pending
            ? "Proposing…"
            : unmigrated.length === 0
              ? "Every term has been decided on"
              : `Propose ${unmigrated.length} term(s) as aliases`}
        </Button>
        <FormStatus error={error} message={message} />
      </div>
    </section>
  );
}
