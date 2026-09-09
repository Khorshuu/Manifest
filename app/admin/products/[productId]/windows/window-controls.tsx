"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { StatusBadge } from "@/components/status-badge";

export type WindowRow = {
  id: string;
  sku: string;
  label: string;
  fulfillmentMode: string;
  capacity: number | null;
  reserved: number;
  closesAtIso: string | null;
  waiting: number;
};

/**
 * The preorder window for one variant.
 *
 * The engine behind this has existed and been tested since Phase 6 with no way
 * for staff to reach it: windows could only be set when a variant was created.
 * This is that missing control.
 *
 * Nothing here decides anything. Capacity below what is already reserved, and
 * a closing date in the past, are both refused by `lib/preorder/lifecycle.ts`
 * inside the transaction that can actually read the reserved count — so the
 * form shows the reason it was refused rather than pre-empting it and
 * disagreeing with the server.
 */
export function WindowControls({
  variant,
  serverNow,
}: {
  variant: WindowRow;
  /**
   * The instant the page was rendered at, from the database clock.
   *
   * Reading `Date.now()` during render is not a pure operation and React
   * forbids it — a re-render would silently get a different answer. It is also
   * the wrong clock: whether a window has shut is decided by the database
   * everywhere else in this system, so the page it is decided on should agree.
   */
  serverNow: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const closesAt = variant.closesAtIso ? new Date(variant.closesAtIso) : null;
  const closed = closesAt !== null && closesAt.getTime() <= serverNow;
  const isPreorder = variant.fulfillmentMode === "preorder";
  const remaining =
    variant.capacity === null
      ? null
      : Math.max(0, variant.capacity - variant.reserved);

  async function send(body: Record<string, unknown>, label: string) {
    setPending(label);
    setError(null);
    setDone(null);

    try {
      const response = await fetch(
        `/api/admin/variants/${variant.id}/window`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.error ?? "That could not be saved.");
        return;
      }

      setDone(label);
      // The figures are read back from the server rather than patched here, so
      // what is on screen is what was actually stored.
      router.refresh();
    } catch {
      setError("That could not be saved. Check your connection.");
    } finally {
      setPending(null);
    }
  }

  /** A datetime-local value, in the browser's own zone, as an ISO instant. */
  function toIso(value: FormDataEntryValue | null): string | null {
    if (typeof value !== "string" || value === "") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /** An ISO instant as the datetime-local value that shows the same moment. */
  function toLocalInput(date: Date | null): string {
    if (!date) return "";
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 border border-blue-300 bg-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-h3 text-ink">{variant.label}</h2>
          <p className="text-meta text-ink/70">{variant.sku}</p>
        </div>

        <StatusBadge
          tone={
            !isPreorder
              ? "neutral"
              : closed
                ? "negative"
                : remaining === 0
                  ? "negative"
                  : "preorder"
          }
        >
          {!isPreorder
            ? "In stock, no window"
            : closed
              ? "Closed"
              : remaining === 0
                ? "Full"
                : "Open"}
        </StatusBadge>
      </div>

      <dl className="grid grid-cols-2 gap-px border border-blue-200 bg-blue-200 sm:grid-cols-4">
        <div className="bg-paper p-3">
          <dt className="text-meta text-ink/70">Capacity</dt>
          <dd className="mt-1 tabular-nums text-ink">
            {variant.capacity ?? "Uncapped"}
          </dd>
        </div>
        <div className="bg-paper p-3">
          <dt className="text-meta text-ink/70">Reserved</dt>
          <dd className="mt-1 tabular-nums text-ink">{variant.reserved}</dd>
        </div>
        <div className="bg-paper p-3">
          <dt className="text-meta text-ink/70">Remaining</dt>
          <dd className="mt-1 tabular-nums text-ink">{remaining ?? "—"}</dd>
        </div>
        <div className="bg-paper p-3">
          <dt className="text-meta text-ink/70">Waiting</dt>
          <dd className="mt-1 tabular-nums text-ink">{variant.waiting}</dd>
        </div>
      </dl>

      <p className="text-meta text-ink/70">
        {closesAt
          ? `${closed ? "Closed" : "Closes"} ${closesAt.toLocaleString()}`
          : "No closing date set."}
      </p>

      {/* Open, or change the terms of an open window. */}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const raw = data.get("capacity");
          const capacity =
            typeof raw === "string" && raw.trim() !== ""
              ? Number(raw)
              : null;

          void send(
            {
              action: "open",
              capacity,
              closesAt: toIso(data.get("closesAt")),
            },
            "open",
          );
        }}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <label
            htmlFor={`capacity-${variant.id}`}
            className="text-meta font-medium text-ink"
          >
            Places in the batch
          </label>
          <input
            id={`capacity-${variant.id}`}
            name="capacity"
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={variant.capacity ?? ""}
            placeholder="Leave empty for no limit"
            className="min-h-11 w-56 rounded-control border border-blue-300 px-3 text-body text-ink"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <label
            htmlFor={`closes-${variant.id}`}
            className="text-meta font-medium text-ink"
          >
            Ordering closes
          </label>
          <input
            id={`closes-${variant.id}`}
            name="closesAt"
            type="datetime-local"
            defaultValue={toLocalInput(closesAt)}
            className="min-h-11 rounded-control border border-blue-300 px-3 text-body text-ink"
          />
        </div>

        <Button type="submit" disabled={pending !== null}>
          {pending === "open"
            ? "Saving…"
            : isPreorder
              ? "Save window"
              : "Open window"}
        </Button>
      </form>

      <div className="flex flex-wrap items-end gap-3 border-t border-blue-200 pt-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const closesAtIso = toIso(
              new FormData(event.currentTarget).get("closesAt"),
            );
            if (!closesAtIso) {
              setError("Choose the new closing date first.");
              return;
            }
            void send({ action: "extend", closesAt: closesAtIso }, "extend");
          }}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <label
              htmlFor={`extend-${variant.id}`}
              className="text-meta font-medium text-ink"
            >
              Extend to
            </label>
            <input
              id={`extend-${variant.id}`}
              name="closesAt"
              type="datetime-local"
              className="min-h-11 rounded-control border border-blue-300 px-3 text-body text-ink"
            />
          </div>
          <Button type="submit" variant="secondary" disabled={pending !== null}>
            {pending === "extend" ? "Extending…" : "Extend"}
          </Button>
        </form>

        {/*
          Closing keeps every reserved place: those are orders that still have
          to be fulfilled. It is also reversible — extending reopens a window
          that has closed — so it does not ask for a confirmation.
        */}
        <Button
          type="button"
          variant="secondary"
          disabled={pending !== null || !isPreorder || closed}
          onClick={() => void send({ action: "close" }, "close")}
        >
          {pending === "close" ? "Closing…" : "Close now"}
        </Button>
      </div>

      <p aria-live="polite" className="text-meta">
        {error ? (
          <span className="text-stamp-red-text">{error}</span>
        ) : done === "open" ? (
          <span className="text-transit-green-text">Window saved.</span>
        ) : done === "extend" ? (
          <span className="text-transit-green-text">Closing date moved.</span>
        ) : done === "close" ? (
          <span className="text-transit-green-text">
            Window closed. The {variant.reserved} reserved place
            {variant.reserved === 1 ? "" : "s"} are unaffected.
          </span>
        ) : null}
      </p>
    </div>
  );
}
