import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { can } from "@/lib/auth/authorize";
import { getVocabularyView, intelligenceQueue } from "@/lib/pkb/intelligence";
import { LabelMapper } from "./label-mapper";
import { TrustManager } from "./trust-manager";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Knowledge" };

/**
 * The knowledge screen: what is waiting for a person, the labels no attribute
 * names yet, and the trust decisions — which domains speak for a brand, and
 * what counts as evidence enough to call a value verified.
 *
 * Reading is open to anyone who manages the catalogue. Approving a mapping, a
 * source or a policy needs `knowledge.manage`, and the API checks it again.
 */
export default async function AdminKnowledgePage() {
  const user = await requireAdminPage("catalog.manage");
  const [queue, vocabulary] = await Promise.all([intelligenceQueue(user, { limit: 40 }), getVocabularyView(user)]);
  const mayDecide = can(user, "knowledge.manage");

  const tiles = [
    { label: "Products waiting", value: queue.length },
    { label: "Conflicts", value: queue.reduce((total, row) => total + row.conflicts, 0) },
    { label: "Claims to review", value: queue.reduce((total, row) => total + row.openClaims, 0) },
    { label: "Labels to place", value: vocabulary.unmappedLabels.length },
  ];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl text-ink">Product knowledge</h1>
        <p className="max-w-2xl text-sm text-ink/70">
          Facts about products, where each one came from, and what is still waiting for a decision. Nothing on this
          screen is written by a machine on its own: a value becomes a fact when someone accepts it.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-line bg-surface p-4">
            <p className="text-[0.7rem] uppercase tracking-wide text-ink/55">{tile.label}</p>
            <p className="font-display text-2xl text-ink">{tile.value.toLocaleString("en-GB")}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg text-ink">Waiting for you</h2>
        {queue.length === 0 ? (
          <EmptyState title="Nothing is waiting" body="No conflicts, proposed values or unplaced labels." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-line text-left text-[0.7rem] uppercase tracking-wide text-ink/55">
                <tr>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Identity</th>
                  <th className="px-4 py-3">Conflicts</th>
                  <th className="px-4 py-3">Claims</th>
                  <th className="px-4 py-3">New attributes</th>
                  <th className="px-4 py-3">Labels</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((row) => (
                  <tr key={row.pkbProductId} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-3">
                      {row.listingId ? (
                        <Link className="text-blue-600 hover:underline" href={`/admin/products/${row.listingId}/intelligence`}>
                          {row.title}
                        </Link>
                      ) : (
                        row.title
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink/70">{row.resolutionState}</td>
                    <td className="px-4 py-3">{row.conflicts > 0 ? <strong>{row.conflicts}</strong> : "—"}</td>
                    <td className="px-4 py-3">{row.openClaims || "—"}</td>
                    <td className="px-4 py-3">{row.openProposals || "—"}</td>
                    <td className="px-4 py-3">{row.unmappedRows || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <LabelMapper
        groups={vocabulary.unmappedLabels}
        definitions={vocabulary.definitions}
        mappings={vocabulary.labelMappings}
        mayDecide={mayDecide}
      />

      <TrustManager
        registry={vocabulary.registry}
        policies={vocabulary.policies}
        relations={vocabulary.brandRelations}
        mayDecide={mayDecide}
      />
    </div>
  );
}
