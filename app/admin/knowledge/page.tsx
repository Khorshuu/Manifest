import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { can } from "@/lib/auth/authorize";
import { getVocabularyView, intelligenceQueue } from "@/lib/pkb/intelligence";
import { classifyParkedValues, legacyCoverage, type ParkedClass } from "@/lib/pkb/legacy-coverage";
import { LabelMapper } from "./label-mapper";
import { TrustManager } from "./trust-manager";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Knowledge" };

/** What each class of parked value means, in the words an operator would use (D-109). */
const PARKED_CAPTIONS: Record<ParkedClass, string> = {
  migratable: "An attribute already answers to this label. Map it and it is placed.",
  already_represented: "The knowledge base already holds this value.",
  ambiguous: "No attribute means this yet. Somebody has to say what it is.",
  obsolete: "The listing is archived. Kept for history only.",
  unusable: "Not a value anything can hold — kept exactly as supplied.",
};

const PARKED_LABELS: [ParkedClass, string][] = [
  ["migratable", "Ready to place"],
  ["already_represented", "Already held"],
  ["ambiguous", "Needs a decision"],
  ["obsolete", "Archived listing"],
  ["unusable", "Unusable"],
];

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
  const [queue, vocabulary, coverage, parked] = await Promise.all([
    intelligenceQueue(user, { limit: 40 }),
    getVocabularyView(user),
    legacyCoverage(user),
    classifyParkedValues(user),
  ]);
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

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg text-ink">What still lives in the old tables</h2>
          <p className="max-w-3xl text-sm text-ink/70">
            The knowledge base was built beside the original catalogue tables rather than on top of them, so both
            still hold the same facts. An old table is only removed once everything in it is also in here and
            nothing reads it any more — these are the counts that decide that, taken from the database each time
            this page is drawn.
          </p>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-line text-left text-[0.7rem] uppercase tracking-wide text-ink/55">
              <tr>
                <th className="px-4 py-3">Where it lives</th>
                <th className="px-4 py-3">In the knowledge base</th>
                <th className="px-4 py-3">What is in the way</th>
              </tr>
            </thead>
            <tbody>
              {coverage.systems.map((system) => (
                <tr key={system.system} className="border-b border-line/60 last:border-0 align-top">
                  <td className="px-4 py-3">{system.system}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {system.covered.toLocaleString("en-GB")} of {system.total.toLocaleString("en-GB")}
                  </td>
                  <td className="px-4 py-3 text-ink/70">
                    {system.blocking ?? "Nothing — everything here is also in the knowledge base."}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {coverage.parkedValues > 0 ? (
          <p className="text-sm text-ink/70">
            {coverage.parkedValues.toLocaleString("en-GB")} value(s) are parked, waiting for someone to say what
            they are. They are shown against their listings and nothing is guessed on their behalf.
          </p>
        ) : null}
      </section>

      {parked.total > 0 ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="font-display text-lg text-ink">What the parked values are</h2>
            <p className="max-w-3xl text-sm text-ink/70">
              Every value the pipeline would not place, sorted by what can be done with it. A value is only called
              &ldquo;ready to place&rdquo; when the knowledge base already holds an attribute that answers to its
              label — approving the mapping above then places it through the normal pipeline, with its provenance.
              Nothing here is decided by guessing what a label means.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {PARKED_LABELS.map(([name, caption]) => (
              <div key={name} className="rounded-xl border border-line bg-surface p-4">
                <p className="text-[0.7rem] uppercase tracking-wide text-ink/55">{caption}</p>
                <p className="font-display text-2xl text-ink">
                  {parked.counts[name].toLocaleString("en-GB")}
                </p>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b border-line text-left text-[0.7rem] uppercase tracking-wide text-ink/55">
                <tr>
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">What it is</th>
                  <th className="px-4 py-3">Values</th>
                  <th className="px-4 py-3">Example</th>
                </tr>
              </thead>
              <tbody>
                {parked.groups.slice(0, 40).map((group) => (
                  <tr
                    key={`${group.parkedClass}-${group.legacyRef}-${group.label}`}
                    className="border-b border-line/60 align-top last:border-0"
                  >
                    <td className="px-4 py-3">
                      <span className="text-ink">{group.label}</span>
                      <span className="block text-[0.7rem] text-ink/55">{group.legacyRef}</span>
                    </td>
                    <td className="px-4 py-3 text-ink/70">
                      {PARKED_CAPTIONS[group.parkedClass]}
                      {group.definition ? <span className="block text-[0.7rem]">→ {group.definition.label}</span> : null}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {group.rows.toLocaleString("en-GB")} on {group.listings.toLocaleString("en-GB")} listing(s)
                    </td>
                    <td className="px-4 py-3 text-ink/70">
                      {group.samples[0] ? `${group.samples[0].title}: ${group.samples[0].value}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {parked.groups.length > 40 ? (
            <p className="text-sm text-ink/60">
              Showing the 40 largest groups of {parked.groups.length.toLocaleString("en-GB")}.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
