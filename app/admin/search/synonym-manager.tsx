"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import type { SynonymEntry } from "@/lib/search/synonyms";
import { FormStatus, inputClass, LabelledField } from "../products/[productId]/editor-parts";

/**
 * Adding, changing and removing synonyms.
 *
 * The form states what an entry will do before it is saved ("a search for
 * cellphone will also find phone"), because the difference between one-way and
 * two-way is exactly the kind of thing that is obvious in a sentence and
 * invisible in a checkbox.
 */
export function SynonymManager({
  initial,
  prefillTerm = "",
}: {
  initial: SynonymEntry[];
  prefillTerm?: string;
}) {
  const router = useRouter();
  const [entries, setEntries] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [term, setTerm] = useState(prefillTerm);
  const [synonyms, setSynonyms] = useState("");
  const [bidirectional, setBidirectional] = useState(true);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const list = synonyms
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  function reset() {
    setEditing(null);
    setTerm("");
    setSynonyms("");
    setBidirectional(true);
  }

  function edit(entry: SynonymEntry) {
    setEditing(entry.id);
    setTerm(entry.term);
    setSynonyms(entry.synonyms.join(", "));
    setBidirectional(entry.bidirectional);
    setError(null);
    setMessage(null);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch(
      editing ? `/api/admin/search/synonyms/${editing}` : "/api/admin/search/synonyms",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ term, synonyms: list, bidirectional }),
      },
    );

    setPending(false);
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    const saved = body.synonym as SynonymEntry;
    setEntries((current) =>
      [...current.filter((entry) => entry.id !== saved.id), saved].sort((a, b) =>
        a.term.localeCompare(b.term),
      ),
    );
    setMessage(editing ? `“${saved.term}” updated.` : `“${saved.term}” added.`);
    reset();
    router.refresh();
  }

  async function remove(entry: SynonymEntry) {
    if (confirming !== entry.id) {
      setConfirming(entry.id);
      return;
    }

    setPending(true);
    setError(null);
    setMessage(null);
    const response = await fetch(`/api/admin/search/synonyms/${entry.id}`, {
      method: "DELETE",
    });
    setPending(false);
    setConfirming(null);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setEntries((current) => current.filter((item) => item.id !== entry.id));
    if (editing === entry.id) reset();
    setMessage(`“${entry.term}” removed.`);
    router.refresh();
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="min-w-0">
        {entries.length === 0 ? (
          <EmptyState
            title="No synonyms yet"
            body="Search matches the words the listings use. Add a synonym when shoppers use a different one."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-blue-300 bg-paper px-4 py-3 shadow-[var(--shadow-raise)]"
              >
                <div className="min-w-0">
                  <p className="text-body text-ink [overflow-wrap:anywhere]">
                    <strong className="font-semibold">{entry.term}</strong>{" "}
                    <span aria-hidden="true" className="text-ink/70">
                      {entry.bidirectional ? "⇄" : "→"}
                    </span>
                    <span className="sr-only">
                      {entry.bidirectional ? " works both ways with " : " also finds "}
                    </span>{" "}
                    {entry.synonyms.join(", ")}
                  </p>
                  <p className="text-meta text-ink/70">
                    {entry.bidirectional ? "Two-way" : "One-way"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() => edit(entry)}
                  >
                    Edit<span className="sr-only"> {entry.term}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={pending}
                    onClick={() => remove(entry)}
                  >
                    {confirming === entry.id ? "Confirm remove" : "Remove"}
                    <span className="sr-only"> {entry.term}</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={save}
        noValidate
        className="flex flex-col gap-4 rounded-card border border-blue-300 bg-paper-raised p-4"
      >
        <h3 className="font-display text-h3 text-ink">
          {editing ? "Change a synonym" : "Add a synonym"}
        </h3>

        <LabelledField
          label="When a shopper searches for"
          htmlFor="synonymTerm"
          hint="A word or a short phrase."
        >
          <input
            id="synonymTerm"
            value={term}
            maxLength={60}
            placeholder="cellphone"
            onChange={(event) => setTerm(event.target.value)}
            className={inputClass}
          />
        </LabelledField>

        <LabelledField
          label="Also find"
          htmlFor="synonymList"
          hint="Separated by commas. Up to twelve."
        >
          <input
            id="synonymList"
            value={synonyms}
            placeholder="phone, mobile"
            onChange={(event) => setSynonyms(event.target.value)}
            className={inputClass}
          />
        </LabelledField>

        <label className="flex min-h-11 items-center gap-3 text-body text-ink">
          <input
            type="checkbox"
            checked={bidirectional}
            onChange={(event) => setBidirectional(event.target.checked)}
            className="size-4"
          />
          Works both ways
        </label>

        {term.trim() && list.length > 0 ? (
          <p className="text-meta text-ink/80">
            A search for “{term.trim()}” will also find {list.map((entry) => `“${entry}”`).join(", ")}
            {bidirectional
              ? `, and a search for any of those will also find “${term.trim()}”.`
              : "."}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Add synonym"}
          </Button>
          {editing ? (
            <Button type="button" variant="quiet" onClick={reset}>
              Cancel
            </Button>
          ) : null}
        </div>
        <FormStatus error={error} message={message} />
      </form>
    </div>
  );
}
