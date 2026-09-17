"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import type { VocabularyView } from "@/lib/pkb/intelligence";

const ROLE_LABELS: Record<string, string> = {
  official_product: "Official product page",
  official_support: "Official support",
  official_documentation: "Official documentation",
  manufacturer_feed: "Manufacturer feed",
  authorized_distributor: "Authorised distributor",
  trusted_retailer: "Trusted retailer",
  product_database: "Product database",
  supplier_feed: "Supplier feed",
  approved_secondary: "Approved secondary source",
  blocked: "Blocked",
};

/**
 * The trust decisions: which domains and feeds speak for a brand, which
 * brands stand behind which, and what counts as evidence enough for VERIFIED.
 *
 * A brand existing in the catalogue is not trust. Every entry here starts as a
 * suggestion and carries no authority until someone approves it, and a blocked
 * domain overrides any other entry for the same host.
 */
export function TrustManager({
  registry,
  policies,
  relations,
  mayDecide,
}: {
  registry: VocabularyView["registry"];
  policies: VocabularyView["policies"];
  relations: VocabularyView["brandRelations"];
  mayDecide: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, body: unknown, key: string) {
    setPending(key);
    setError(null);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setPending(null);
    if (!response.ok) {
      const parsed = await response.json().catch(() => ({}));
      setError(parsed.error ?? "Something went wrong. Try again.");
      return;
    }
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg text-ink">Sources and trust</h2>
        <p className="max-w-2xl text-sm text-ink/70">
          Where a fact may come from. A domain is only authoritative once it is approved here, and a verification policy
          decides what evidence is enough to call a value verified.
        </p>
      </div>

      {error ? <p role="alert" className="text-sm text-stamp-red-text">{error}</p> : null}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[42rem] text-sm">
          <thead className="border-b border-line text-left text-[0.7rem] uppercase tracking-wide text-ink/55">
            <tr>
              <th className="px-4 py-3">Brand</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {registry.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-ink/60" colSpan={6}>
                  No source is registered yet. Until one is approved, enrichment reads only the pages staff attach to a
                  product and the documents they provide.
                </td>
              </tr>
            ) : (
              registry.map((entry) => (
                <tr key={entry.id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-3">{entry.brandName ?? "Any brand"}</td>
                  <td className="px-4 py-3">
                    {entry.domain ?? entry.providerKey ?? "—"}
                    {entry.urlTemplate ? <span className="block text-[0.7rem] text-ink/55">{entry.urlTemplate}</span> : null}
                  </td>
                  <td className="px-4 py-3">{ROLE_LABELS[entry.role] ?? entry.role}</td>
                  <td className="px-4 py-3">{entry.authorityTier ?? "—"}</td>
                  <td className="px-4 py-3">{entry.status}</td>
                  <td className="px-4 py-3 text-right">
                    {mayDecide && entry.status === "suggested" ? (
                      <span className="flex justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending === entry.id}
                          onClick={() => void post("/api/admin/knowledge/registry", { action: "decide", entryId: entry.id, decision: "approved" }, entry.id)}
                        >
                          Approve
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={pending === entry.id}
                          onClick={() => void post("/api/admin/knowledge/registry", { action: "decide", entryId: entry.id, decision: "rejected" }, entry.id)}
                        >
                          Reject
                        </Button>
                      </span>
                    ) : null}
                    {mayDecide && entry.status === "approved" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={pending === entry.id}
                        onClick={() => void post("/api/admin/knowledge/registry", { action: "decide", entryId: entry.id, decision: "retired" }, entry.id)}
                      >
                        Retire
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        <h3 className="text-sm font-medium text-ink">Verification policies</h3>
        <ul className="flex flex-col gap-2">
          {policies.map((policy) => (
            <li key={policy.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-line/60 pb-2 last:border-0 last:pb-0">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm text-ink">
                  {policy.name} <span className="text-[0.7rem] text-ink/55">({policy.status})</span>
                </p>
                <p className="max-w-xl text-[0.75rem] text-ink/65">{policy.description}</p>
              </div>
              {mayDecide ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={pending === policy.id}
                  onClick={() =>
                    void post(
                      "/api/admin/knowledge/policies",
                      { policyId: policy.id, status: policy.status === "active" ? "retired" : "active" },
                      policy.id,
                    )
                  }
                >
                  {policy.status === "active" ? "Turn off" : "Turn on"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {relations.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <h3 className="text-sm font-medium text-ink">Brand relations</h3>
          <ul className="flex flex-col gap-1 text-[0.8rem] text-ink/75">
            {relations.map((relation) => (
              <li key={relation.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {relation.brandName} {relation.kind.replace(/_/g, " ")} {relation.relatedName}{" "}
                  <span className="text-ink/55">({relation.status})</span>
                </span>
                {mayDecide && relation.status === "suggested" ? (
                  <span className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending === relation.id}
                      onClick={() => void post("/api/admin/knowledge/brand-relations", { action: "decide", relationId: relation.id, decision: "approved" }, relation.id)}
                    >
                      Approve
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending === relation.id}
                      onClick={() => void post("/api/admin/knowledge/brand-relations", { action: "decide", relationId: relation.id, decision: "rejected" }, relation.id)}
                    >
                      Reject
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
