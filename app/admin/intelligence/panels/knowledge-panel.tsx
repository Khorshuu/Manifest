import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import type { SessionUser } from "@/lib/auth/session";
import {
  intelligenceQueue,
  knowledgeAttention,
  listIdentities,
  type IntelligenceQueueRow,
} from "@/lib/pkb/intelligence";
import { classifyParkedValues, legacyCoverage, type ParkedClass } from "@/lib/pkb/legacy-coverage";
import {
  IDENTITY_FOCUS,
  KNOWLEDGE_FOCUS_LABEL as FOCUS_LABEL,
  type KnowledgeFocus,
} from "../filters";
import { Metric, MetricGrid, Section, TabHeading, TableShell } from "../ui";

/**
 * The Product Knowledge tab.
 *
 * What the knowledge base holds, where it came from, and what is waiting for a
 * person. It is the same review queue the Knowledge screen has always shown,
 * organised as a management surface: the counts first, then the products that
 * need a decision, then the technical residue of the migration last.
 *
 * Nothing on this screen decides anything. A decision is made against one
 * product, with its evidence beside it, on the product intelligence screen —
 * and the trust rules that govern what counts as evidence live on the Sources
 * &amp; Policies tab. Verification semantics are untouched by this view.
 */

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

const RESOLUTION_LABEL: Record<string, string> = {
  VERIFIED: "Confirmed",
  HIGH_CONFIDENCE: "Very likely",
  AMBIGUOUS: "More than one match",
  UNRESOLVED: "Not identified",
};

function matchesFocus(row: IntelligenceQueueRow, focus: KnowledgeFocus | undefined): boolean {
  if (!focus || IDENTITY_FOCUS.includes(focus)) return true;
  if (focus === "conflicts") return row.conflicts > 0;
  if (focus === "claims") return row.openClaims > 0;
  if (focus === "proposals") return row.openProposals > 0;
  return row.unmappedRows > 0;
}

export async function KnowledgePanel({
  user,
  focus,
}: {
  user: SessionUser;
  focus?: KnowledgeFocus;
}) {
  const identityState = focus === "ambiguous" ? "AMBIGUOUS" : "UNRESOLVED";
  const [attention, queue, coverage, parked, identities] = await Promise.all([
    knowledgeAttention(user),
    intelligenceQueue(user, { limit: 60 }),
    legacyCoverage(user),
    classifyParkedValues(user),
    focus && IDENTITY_FOCUS.includes(focus)
      ? listIdentities(user, identityState, { limit: 60 })
      : Promise.resolve([]),
  ]);

  const rows = queue.filter((row) => matchesFocus(row, focus));

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <TabHeading title="Product Knowledge">
        Facts about products, where each one came from, and what is still waiting for a decision. Nothing here is
        written by a machine on its own: a value becomes a fact when somebody accepts it.
      </TabHeading>

      <MetricGrid>
        <Metric
          label="Conflicts"
          value={attention.conflicts}
          note="values that disagree"
          tone={attention.conflicts > 0 ? "attention" : "plain"}
          href="/admin/intelligence/knowledge?focus=conflicts"
        />
        <Metric
          label="Proposed values"
          value={attention.openClaims}
          note="waiting to be accepted"
          href="/admin/intelligence/knowledge?focus=claims"
        />
        <Metric
          label="New attributes"
          value={attention.openProposals}
          note="proposed by a run"
          href="/admin/intelligence/knowledge?focus=proposals"
        />
        <Metric
          label="Unplaced labels"
          value={attention.unmappedValues}
          note="no attribute answers to them"
          href="/admin/intelligence/knowledge?focus=labels"
        />
        <Metric
          label="Not identified"
          value={attention.unresolvedIdentities}
          note="nobody has settled which product"
          tone={attention.unresolvedIdentities > 0 ? "attention" : "plain"}
          href="/admin/intelligence/knowledge?focus=unresolved"
        />
        <Metric
          label="More than one match"
          value={attention.ambiguousIdentities}
          note="several candidates still fit"
          href="/admin/intelligence/knowledge?focus=ambiguous"
        />
        <Metric
          label="Verification policies"
          value={attention.activePolicies}
          note="in force"
          href="/admin/intelligence/sources#registry"
        />
        <Metric
          label="Sources suggested"
          value={attention.suggestedSources}
          note="waiting for approval"
          href="/admin/intelligence/sources#registry"
        />
      </MetricGrid>

      {focus && IDENTITY_FOCUS.includes(focus) ? (
        <Section
          id="identities"
          title={FOCUS_LABEL[focus]}
          description={
            <>
              {focus === "unresolved"
                ? "Products whose identity nobody has settled. Until one is settled, research has nothing definite to look for."
                : "Products where more than one candidate still fits. Somebody has to say which one it is."}{" "}
              <Link href="/admin/intelligence/knowledge" className="text-blue-600 hover:underline">
                Show everything waiting
              </Link>
              .
            </>
          }
        >
          {identities.length === 0 ? (
            <EmptyState
              title={focus === "unresolved" ? "Every product is identified" : "No product is ambiguous"}
              body="No product knowledge record is in this state."
            />
          ) : (
            <TableShell>
              <table className="admin-table min-w-[32rem]">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Identity</th>
                    <th scope="col">Last changed</th>
                  </tr>
                </thead>
                <tbody>
                  {identities.map((row) => (
                    <tr key={row.pkbProductId}>
                      <td>
                        {row.listingId ? (
                          <Link
                            href={`/admin/products/${row.listingId}/intelligence`}
                            className="text-blue-600 hover:underline"
                          >
                            {row.title}
                          </Link>
                        ) : (
                          row.title
                        )}
                      </td>
                      <td className="text-ink/70">
                        {RESOLUTION_LABEL[row.resolutionState] ?? row.resolutionState}
                      </td>
                      <td className="whitespace-nowrap tabular-nums text-ink/70">
                        {row.updatedAt.toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          )}
        </Section>
      ) : null}

      <Section
        id="queue"
        title={focus && !IDENTITY_FOCUS.includes(focus) ? `Waiting for you — ${FOCUS_LABEL[focus]}` : "Waiting for you"}
        description={
          focus && !IDENTITY_FOCUS.includes(focus) ? (
            <>
              Products with {FOCUS_LABEL[focus].toLowerCase()}.{" "}
              <Link href="/admin/intelligence/knowledge" className="text-blue-600 hover:underline">
                Show everything waiting
              </Link>
              .
            </>
          ) : (
            "Products with something to accept, reject or name. Open one to decide with its evidence beside it."
          )
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing is waiting"
            body="No product knowledge conflicts, proposed values or unplaced labels need review."
          />
        ) : (
          <TableShell>
            <table className="admin-table min-w-[40rem]">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Identity</th>
                  <th scope="col">Conflicts</th>
                  <th scope="col">Proposed values</th>
                  <th scope="col">New attributes</th>
                  <th scope="col">Labels</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.pkbProductId}>
                    <td>
                      {row.listingId ? (
                        <Link
                          href={`/admin/products/${row.listingId}/intelligence`}
                          className="text-blue-600 hover:underline"
                        >
                          {row.title}
                        </Link>
                      ) : (
                        row.title
                      )}
                    </td>
                    <td className="text-ink/70">
                      {RESOLUTION_LABEL[row.resolutionState] ?? row.resolutionState}
                    </td>
                    <td className="tabular-nums">{row.conflicts > 0 ? <strong>{row.conflicts}</strong> : "—"}</td>
                    <td className="tabular-nums">{row.openClaims || "—"}</td>
                    <td className="tabular-nums">{row.openProposals || "—"}</td>
                    <td className="tabular-nums">{row.unmappedRows || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Section>

      {parked.total > 0 ? (
        <Section
          id="parked"
          title="Values nothing could place"
          description={
            <>
              Every value the pipeline would not place, sorted by what can be done with it. A value is only
              &ldquo;ready to place&rdquo; when an attribute already answers to its label — approving that mapping on{" "}
              <Link href="/admin/intelligence/sources" className="text-blue-600 hover:underline">
                Sources &amp; Policies
              </Link>{" "}
              places it through the normal pipeline, with its provenance. Nothing here is decided by guessing what a
              label means.
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {PARKED_LABELS.map(([name, caption]) => (
              <Metric key={name} label={caption} value={parked.counts[name]} />
            ))}
          </div>
          <TableShell>
            <table className="admin-table min-w-[44rem]">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">What it is</th>
                  <th scope="col">Values</th>
                  <th scope="col">Example</th>
                </tr>
              </thead>
              <tbody>
                {parked.groups.slice(0, 40).map((group) => (
                  <tr key={`${group.parkedClass}-${group.legacyRef}-${group.label}`} className="align-top">
                    <td>
                      <span className="text-ink">{group.label}</span>
                      <span className="block text-[0.7rem] text-ink/55">{group.legacyRef}</span>
                    </td>
                    <td className="text-ink/70">
                      {PARKED_CAPTIONS[group.parkedClass]}
                      {group.definition ? (
                        <span className="block text-[0.7rem]">→ {group.definition.label}</span>
                      ) : null}
                    </td>
                    <td className="tabular-nums">
                      {group.rows.toLocaleString("en-GB")} on {group.listings.toLocaleString("en-GB")} listing(s)
                    </td>
                    <td className="text-ink/70">
                      {group.samples[0] ? `${group.samples[0].title}: ${group.samples[0].value}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
          {parked.groups.length > 40 ? (
            <p className="text-[0.8125rem] text-ink/60">
              Showing the 40 largest groups of {parked.groups.length.toLocaleString("en-GB")}.
            </p>
          ) : null}
        </Section>
      ) : null}

      <details className="admin-card p-3.5 text-[0.8125rem]">
        <summary className="cursor-pointer font-medium text-ink/80">
          What still lives in the original catalogue tables
        </summary>
        <p className="mt-3 max-w-[74ch] text-ink/65">
          The knowledge base was built beside the original catalogue tables rather than on top of them, so both still
          hold the same facts. An old table is only removed once everything in it is also in here and nothing reads it
          any more — these are the counts that decide that, taken from the database each time this page is drawn.
        </p>
        <div className="mt-3">
          <TableShell>
            <table className="admin-table min-w-[36rem]">
              <thead>
                <tr>
                  <th scope="col">Where it lives</th>
                  <th scope="col">In the knowledge base</th>
                  <th scope="col">What is in the way</th>
                </tr>
              </thead>
              <tbody>
                {coverage.systems.map((system) => (
                  <tr key={system.system} className="align-top">
                    <td>{system.system}</td>
                    <td className="tabular-nums">
                      {system.covered.toLocaleString("en-GB")} of {system.total.toLocaleString("en-GB")}
                    </td>
                    <td className="text-ink/70">
                      {system.blocking ?? "Nothing — everything here is also in the knowledge base."}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </div>
        {coverage.parkedValues > 0 ? (
          <p className="mt-3 text-ink/65">
            {coverage.parkedValues.toLocaleString("en-GB")} value(s) are parked, waiting for somebody to say what they
            are. They are shown against their listings and nothing is guessed on their behalf.
          </p>
        ) : null}
      </details>
    </div>
  );
}
