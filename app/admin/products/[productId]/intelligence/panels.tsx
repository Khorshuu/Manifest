"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import type { ProductIntelligence, VocabularyView } from "@/lib/pkb/intelligence";
import { PROPOSAL_GROUP_LABELS, proposalGroup, type ProposalGroup } from "@/lib/pkb/proposal-groups";
import { inputClass } from "../editor-parts";

const PROPOSAL_GROUP_ORDER: ProposalGroup[] = ["facts", "version", "composition", "use", "safety", "box", "passages"];

/**
 * The review surface: identity, completeness, proposed values with their
 * evidence, discovered attributes, sources and runs.
 *
 * Each action names what it acts on. Accepting as verified is offered only
 * when a policy already qualifies the claim, so the button cannot be used to
 * promote weak evidence, and a conflict is settled by choosing between the
 * claims rather than by overwriting one with the other.
 */
export function IntelligencePanels({
  intelligence,
  definitions,
  mayDecideVocabulary,
}: {
  intelligence: ProductIntelligence;
  definitions: VocabularyView["definitions"];
  mayDecideVocabulary: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const base = `/api/admin/knowledge/products/${intelligence.pkbProductId}`;
  const open = intelligence.claims.filter((row) => row.claim.status === "SUGGESTED" || row.claim.status === "CONFLICT");
  const completeness = intelligence.knowledge.completeness;

  async function post(path: string, body: unknown, key: string, success?: string) {
    setPending(key);
    setError(null);
    setMessage(null);
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    setPending(null);
    if (!response.ok) {
      setError(parsed.error ?? "Something went wrong. Try again.");
      return null;
    }
    if (success) setMessage(success);
    setSelected(new Set());
    router.refresh();
    return parsed;
  }

  function toggle(claimId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(claimId)) next.delete(claimId);
      else next.add(claimId);
      return next;
    });
  }

  const [mapTo, setMapTo] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  /** The attribute's name if a new one is defined: the source's label, less its shouting. */
  const nameFor = (proposal: { id: string; label: string }) =>
    names[proposal.id] ??
    (proposal.label === proposal.label.toUpperCase() && /\p{L}/u.test(proposal.label)
      ? proposal.label.charAt(0) + proposal.label.slice(1).toLowerCase()
      : proposal.label);
  // Grouped for review (D-123): the same decision for similar labels, next to each other.
  const grouped = new Map<ProposalGroup, typeof intelligence.proposals>();
  for (const proposal of intelligence.proposals) {
    const group = proposalGroup(proposal);
    grouped.set(group, [...(grouped.get(group) ?? []), proposal]);
  }
  const mappable = definitions
    .filter((definition) => definition.status === "approved")
    .sort((a, b) => a.label.localeCompare(b.label));

  const chosen = [...selected];
  const chosenClaims = open.filter((row) => selected.has(row.claim.id));
  const allChosenQualify = chosenClaims.length > 0 && chosenClaims.every((row) => row.verification?.eligible);

  return (
    <div className="flex flex-col gap-6">
      {error ? <p role="alert" className="text-sm text-stamp-red-text">{error}</p> : null}
      {message ? <p className="text-sm text-ink/70">{message}</p> : null}

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-lg text-ink">Which product is this?</h2>
          <span className="rounded-full border border-line px-2 py-0.5 text-[0.7rem] uppercase tracking-wide text-ink/70">
            {intelligence.resolution.state.replace(/_/g, " ")}
          </span>
        </div>
        <ul className="flex flex-col gap-1 text-[0.8rem] text-ink/70">
          {intelligence.resolution.reasons.map((reason) => (
            <li key={reason.code}>{reason.message}</li>
          ))}
        </ul>
        {intelligence.resolution.candidates.length > 0 ? (
          <div className="rounded-lg border border-line bg-paper p-3 text-[0.8rem]">
            <p className="font-medium text-ink">Could be confused with</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-ink/70">
              {intelligence.resolution.candidates.map((candidate) => (
                <li key={candidate.pkbProductId}>
                  {candidate.name} — matched on {candidate.matchedOn}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
            How did you confirm which product this is?
            <input
              className={inputClass}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. matched the GTIN on the manufacturer's page"
              maxLength={500}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={pending !== null || note.trim().length < 5}
              onClick={() => void post("/resolve", { action: "confirm", note }, "confirm", "Identity confirmed.")}
            >
              Confirm identity
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending !== null}
              onClick={() => void post("/resolve", { action: "refresh" }, "refresh", "Re-checked.")}
            >
              Re-check
            </Button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        <h2 className="font-display text-lg text-ink">How complete is it?</h2>
        <ul className="grid grid-cols-2 gap-2 text-[0.8rem] text-ink/75 md:grid-cols-4">
          <li>Verified: {completeness.verified}</li>
          <li>Entered by staff: {completeness.manual}</li>
          <li>Unverified: {completeness.unverified}</li>
          <li>From the old listing: {completeness.legacy}</li>
          <li>Locked: {completeness.locked}</li>
          <li>Proposed: {completeness.suggested}</li>
          <li>In conflict: {completeness.conflict}</li>
          <li>Missing, required: {completeness.missingRequired}</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-lg text-ink">Proposed values</h2>
          <span className="text-[0.75rem] text-ink/55">{open.length} waiting</span>
        </div>

        {open.length === 0 ? (
          <p className="text-sm text-ink/65">Nothing is proposed. Add a source, or ask for an enrichment run below.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {open.map((row) => (
                <li key={row.claim.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <label className="flex items-start gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selected.has(row.claim.id)}
                        onChange={() => toggle(row.claim.id)}
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">
                          {row.claim.rawValue ?? "(not applicable)"}
                          {row.claim.valueUnit ? ` ${row.claim.valueUnit}` : ""}
                        </span>
                        <span className="text-[0.75rem] text-ink/60">
                          {row.claim.status} · {row.sourceType.replace(/_/g, " ")}
                          {row.domain ? ` · ${row.domain}` : ""} · tier {row.authorityTier ?? "—"} ·{" "}
                          {row.extractionMethod.replace(/_/g, " ")}
                        </span>
                        {row.excerpt ? <span className="text-[0.75rem] italic text-ink/55">“{row.excerpt}”</span> : null}
                        <span className="text-[0.75rem] text-ink/60">
                          {row.verification?.eligible
                            ? `Verifiable under ${row.verification.policy?.name}`
                            : (row.verification?.reasons[0] ?? "Not verifiable yet")}
                        </span>
                      </span>
                    </label>
                    {row.claim.status === "CONFLICT" ? (
                      <span className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending !== null}
                          onClick={() =>
                            void post("/claims", { action: "resolve_conflict", claimId: row.claim.id }, row.claim.id, "Conflict resolved.")
                          }
                        >
                          Keep this one
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={pending !== null}
                          onClick={() =>
                            void post(
                              "/claims",
                              { action: "resolve_conflict", claimId: row.claim.id, keepCurrent: true },
                              `${row.claim.id}-keep`,
                              "Kept the existing value.",
                            )
                          }
                        >
                          Keep what we have
                        </Button>
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              <Button
                type="button"
                size="sm"
                disabled={pending !== null || chosen.length === 0}
                onClick={() => void post("/claims", { action: "accept", claimIds: chosen }, "accept", "Applied the selected values.")}
              >
                Apply selected ({chosen.length})
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending !== null || !allChosenQualify}
                title={allChosenQualify ? undefined : "Every selected value must qualify under a verification policy."}
                onClick={() =>
                  void post("/claims", { action: "accept", claimIds: chosen, asVerified: true }, "verify", "Accepted as verified.")
                }
              >
                Accept as verified
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pending !== null || chosen.length === 0}
                onClick={() => void post("/claims", { action: "reject", claimIds: chosen }, "reject", "Rejected.")}
              >
                Reject selected
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="font-display text-lg text-ink">New attributes found</h2>
        {intelligence.proposals.length > 0 ? (
          <p className="text-[0.8rem] text-ink/65">
            Labels the sources use that nothing in this shop names yet. Decide each once: the decision is remembered, so
            the next product of this kind is read without asking again. <strong>Add to family</strong> asks every product of
            this kind for it; <strong>This product only</strong> keeps it here; <strong>Map to existing</strong> says it is
            an attribute you already have; <strong>Ignore</strong> is for marketing text and page furniture.
          </p>
        ) : null}
        {intelligence.proposals.length === 0 ? (
          <p className="text-sm text-ink/65">No unknown labels are waiting.</p>
        ) : (
          PROPOSAL_GROUP_ORDER.filter((group) => grouped.has(group)).map((group) => (
            <div key={group} className="flex flex-col gap-2" data-proposal-group={group}>
              <h3 className="text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-ink/70">
                {PROPOSAL_GROUP_LABELS[group]} ({grouped.get(group)!.length})
              </h3>
              <ul className="flex flex-col gap-2">
                {grouped.get(group)!.map((proposal) => (
                  <li key={proposal.id} className="rounded-lg border border-line p-3" data-proposal={proposal.label}>
                    <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">
                      {proposal.label}: {proposal.exampleValue.length > 220 ? `${proposal.exampleValue.slice(0, 217)}…` : proposal.exampleValue}
                    </p>
                    <p className="text-[0.75rem] text-ink/60">
                      Looks like {proposal.dataType}
                      {proposal.displayUnit ? ` in ${proposal.displayUnit}` : ""}
                      {proposal.suggestion?.meaning ? ` · suggested meaning: ${proposal.suggestion.meaning}` : ""}
                      {" · "}
                      {proposal.extractionMethod === "ai_assisted"
                        ? "read with AI assistance and checked against the page's text"
                        : proposal.extractionMethod === "structured_data"
                          ? "from the page's structured data"
                          : "from the page's layout"}
                    </p>
                    {proposal.evidenceExcerpt ? (
                      <p className="mt-1 text-[0.75rem] italic text-ink/55 [overflow-wrap:anywhere]">
                        “{proposal.evidenceExcerpt.length > 300 ? `${proposal.evidenceExcerpt.slice(0, 297)}…` : proposal.evidenceExcerpt}”
                        {proposal.sourceUrl ? (
                          <>
                            {" "}
                            <a className="not-italic text-blue-600 hover:underline" href={proposal.sourceUrl} target="_blank" rel="noreferrer">
                              source
                            </a>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {mayDecideVocabulary ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-1 text-[0.75rem] text-ink/70">
                          Name
                          <input
                            className={`${inputClass} max-w-[11rem] py-1 text-[0.75rem]`}
                            value={nameFor(proposal)}
                            maxLength={80}
                            onChange={(event) => setNames((current) => ({ ...current, [proposal.id]: event.target.value }))}
                          />
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending !== null}
                          onClick={() =>
                            void post(
                              "/proposals",
                              { proposalId: proposal.id, action: "add_to_family", label: nameFor(proposal).trim() || proposal.label },
                              proposal.id,
                              "Added to the family. Products of this kind are now asked for it.",
                            )
                          }
                        >
                          Add to family
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={pending !== null}
                          onClick={() =>
                            void post(
                              "/proposals",
                              { proposalId: proposal.id, action: "product_only", label: nameFor(proposal).trim() || proposal.label },
                              `${proposal.id}-product`,
                              "Kept for this product only.",
                            )
                          }
                        >
                          This product only
                        </Button>
                        <label className="flex items-center gap-1 text-[0.75rem] text-ink/70">
                          <span className="sr-only">Existing attribute for {proposal.label}</span>
                          <select
                            className={`${inputClass} max-w-[12rem] py-1 text-[0.75rem]`}
                            value={mapTo[proposal.id] ?? ""}
                            onChange={(event) => setMapTo((current) => ({ ...current, [proposal.id]: event.target.value }))}
                          >
                            <option value="">Map to existing…</option>
                            {mappable.map((definition) => (
                              <option key={definition.id} value={definition.id}>
                                {definition.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={pending !== null || !mapTo[proposal.id]}
                          onClick={() =>
                            void post(
                              "/proposals",
                              { proposalId: proposal.id, action: "product_only", definitionId: mapTo[proposal.id] },
                              `${proposal.id}-map`,
                              "Mapped. The same label is placed this way from now on.",
                            )
                          }
                        >
                          Map
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={pending !== null}
                          onClick={() =>
                            void post("/proposals", { proposalId: proposal.id, action: "ignore" }, `${proposal.id}-ignore`, "Ignored.")
                          }
                        >
                          Ignore
                        </Button>
                      </div>
                    ) : (
                      <p className="mt-1 text-[0.75rem] text-ink/55">A knowledge manager decides these.</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="font-display text-lg text-ink">Sources</h2>
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
            A page about this product
            <input
              className={inputClass}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
              maxLength={2000}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending !== null || !url.trim()}
              onClick={async () => {
                const result = await post("/sources", { kind: "url", url }, "source", "Source added.");
                if (result) setUrl("");
              }}
            >
              Add source
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                void post(
                  "/enrich",
                  url.trim() ? { urls: [url.trim()] } : {},
                  "enrich",
                  "Asked for a run. It reads the pages in the background.",
                )
              }
            >
              Find what sources say
            </Button>
          </div>
        </div>

        {intelligence.documents.length > 0 ? (
          <ul className="flex flex-col gap-1 border-t border-line pt-3 text-[0.8rem] text-ink/75">
            {intelligence.documents.map((document) => (
              <li key={document.id}>
                {document.status === "refused" ? "Refused" : document.status === "provided" ? "Provided" : "Read"} ·{" "}
                {document.domain ?? document.title ?? "document"} · identity {document.identityMatch.replace(/_/g, " ")}
                {document.refusalReason ? ` · ${document.refusalReason}` : ""}
              </li>
            ))}
          </ul>
        ) : null}

        {intelligence.runs.length > 0 ? (
          <ul className="flex flex-col gap-1 border-t border-line pt-3 text-[0.8rem] text-ink/75">
            {intelligence.runs.map((run) => (
              <li key={run.id}>
                {run.status}
                {run.blockedReason ? ` — ${run.blockedReason}` : ""} · {run.documentsRetrieved} read,{" "}
                {run.documentsRefused} refused, {run.claimsProposed} proposed, {run.proposalsCreated} new labels
                {run.providers.length > 0
                  ? ` · discovery: ${run.providers.map((provider) => `${provider.provider} ${provider.status}`).join(", ")}`
                  : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {intelligence.unmappedLabels.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <h2 className="font-display text-lg text-ink">Labels on this listing nobody has placed</h2>
          <ul className="flex flex-col gap-1 text-[0.8rem] text-ink/75">
            {intelligence.unmappedLabels.map((group) => (
              <li key={`${group.context}|${group.labelNormalized}`}>
                {group.label} ({group.context.replace(/_/g, " ")}) · {group.rows} row(s)
              </li>
            ))}
          </ul>
          <p className="text-[0.75rem] text-ink/60">
            Place them on <a className="text-blue-600 hover:underline" href="/admin/intelligence/sources">Sources &amp; Policies</a>, where the
            decision is remembered for every product that uses the same label.
          </p>
        </section>
      ) : null}

      {definitions.length === 0 ? <p className="text-[0.75rem] text-ink/55">No attributes are defined yet.</p> : null}
    </div>
  );
}
