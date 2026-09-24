"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import type { VocabularyView } from "@/lib/pkb/intelligence";
import { inputClass } from "../products/[productId]/editor-parts";

/**
 * Placing the labels nothing matched.
 *
 * A written label is only attached to an attribute by exact match, so anything
 * a supplier or a source phrased differently waits here. Mapping it once is
 * remembered: every later row with the same label is placed the same way, and
 * the listings holding it are re-synced through the normal pipeline. There is
 * no fuzzy matching — a wrong guess would silently file "Weight" under
 * "Shipping weight" on a thousand products.
 */
export function LabelMapper({
  groups,
  definitions,
  mappings,
  mayDecide,
  heading = true,
}: {
  groups: VocabularyView["unmappedLabels"];
  definitions: VocabularyView["definitions"];
  mappings: VocabularyView["labelMappings"];
  mayDecide: boolean;
  /**
   * The Intelligence workspace gives every block the same heading treatment,
   * so it renders this one without its own title (task section 18). The
   * standalone Knowledge screen keeps it.
   */
  heading?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [definitionId, setDefinitionId] = useState("");
  const [scope, setScope] = useState<"family" | "everywhere">("family");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function decide(group: VocabularyView["unmappedLabels"][number], action: "map" | "ignore") {
    setPending(true);
    setError(null);
    setMessage(null);
    const response = await fetch("/api/admin/knowledge/labels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        label: group.label,
        context: group.context,
        familyId: scope === "family" ? group.familyId : null,
        definitionId: action === "map" ? definitionId : undefined,
        note: note.trim() || null,
      }),
    });
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }
    setOpen(null);
    setDefinitionId("");
    setNote("");
    setMessage(
      action === "map"
        ? `“${group.label}” is mapped. ${body.listingsQueued ?? 0} listing(s) will re-sync.`
        : `“${group.label}” will be ignored from now on.`,
    );
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-3">
      {heading ? (
        <div className="flex flex-col gap-1">
          <h2 className="admin-h2">Labels to place</h2>
          <p className="max-w-[74ch] text-[0.8125rem] text-ink/65">
            Written labels that match no attribute exactly. Say what each one means once, and every product that uses
            it follows. Mark it ignored when it is not an attribute at all.
          </p>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-sm text-stamp-red-text">{error}</p> : null}
      {message ? <p className="text-sm text-ink/70">{message}</p> : null}

      {groups.length === 0 ? (
        <EmptyState title="Every label is placed" body="Nothing is waiting to be mapped." />
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((group) => {
            const key = `${group.context}|${group.familyId ?? "*"}|${group.labelNormalized}`;
            return (
              <li key={key} className="admin-card p-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <p className="font-medium text-ink">{group.label}</p>
                    <p className="text-[0.75rem] text-ink/60">
                      {group.context.replace(/_/g, " ")} · {group.rows} row(s) on {group.listings} listing(s)
                      {group.familyName ? ` · ${group.familyName}` : " · no family"} · {group.reasons.join(", ").replace(/_/g, " ")}
                    </p>
                    <p className="text-[0.75rem] text-ink/55">
                      e.g. {group.samples.map((sample) => `${sample.title}: ${sample.value}`).join(" · ")}
                    </p>
                  </div>
                  {mayDecide ? (
                    <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(open === key ? null : key)}>
                      {open === key ? "Close" : "Decide"}
                    </Button>
                  ) : (
                    <span className="text-[0.75rem] text-ink/55">Needs a knowledge manager</span>
                  )}
                </div>

                {open === key ? (
                  <div className="mt-3 flex flex-col gap-2 border-t border-blue-200 pt-3">
                    <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
                      This label means
                      <select className={inputClass} value={definitionId} onChange={(event) => setDefinitionId(event.target.value)}>
                        <option value="">Choose an attribute…</option>
                        {definitions.map((definition) => (
                          <option key={definition.id} value={definition.id}>
                            {definition.label} ({definition.dataType})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
                      Applies to
                      <select
                        className={inputClass}
                        value={scope}
                        onChange={(event) => setScope(event.target.value as "family" | "everywhere")}
                      >
                        <option value="family">{group.familyName ? `Only ${group.familyName}` : "Only products with no family"}</option>
                        <option value="everywhere">Every product</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
                      Why (optional)
                      <input className={inputClass} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" disabled={pending || !definitionId} onClick={() => void decide(group, "map")}>
                        Map to attribute
                      </Button>
                      <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => void decide(group, "ignore")}>
                        Not an attribute
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {mappings.length > 0 ? (
        <details className="admin-card p-3.5">
          <summary className="cursor-pointer text-sm font-medium text-ink">Decisions already made ({mappings.length})</summary>
          <ul className="mt-2 flex flex-col gap-1 text-[0.75rem] text-ink/70">
            {mappings.map((mapping) => (
              <li key={mapping.id}>
                “{mapping.label}” ({mapping.context.replace(/_/g, " ")}
                {mapping.familyName ? `, ${mapping.familyName}` : ""}) →{" "}
                {mapping.action === "ignore" ? "ignored" : (mapping.definitionLabel ?? "an attribute")}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
