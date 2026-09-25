"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import {
  attentionSummary,
  describeDiscovery,
  describeIssue,
  preparationPhases,
  shouldKeepPolling,
  STAGE_LABEL,
  STAGE_SUMMARY,
  type IssueAction,
  type PreparationIssue,
} from "@/lib/preparation/presentation";
import type { PreparationNote, PreparationStage, PreparationStepRecord } from "@/lib/preparation/types";

/**
 * The one surface product preparation reports itself through (D-116).
 *
 * Everything a normal staff member needs to know about a preparation run is
 * here, in their words: what is happening, what finished, what needs them, and
 * one button for each. The systems behind it — the knowledge base, the
 * research pipeline, the review queue, the content generator — are never
 * named, and their screens are linked to rather than replaced.
 *
 * Three properties it has to keep, all of which come from the backend rather
 * than from this file. The run is durable, so this component *discovers* the
 * latest run on mount and never starts one because it remounted. Starting is
 * idempotent on a request key, so a double click or a retried request returns
 * the run it already made. And the progress shown is the run's own recorded
 * steps: nothing here estimates, predicts or animates a percentage.
 */

export type PreparationRunView = {
  id: string;
  stage: PreparationStage;
  steps: PreparationStepRecord[];
  review: PreparationNote[];
  failure: PreparationNote | null;
  seoRunId: string | null;
  updatedAt: string;
};

/** Slow enough not to hammer the server, fast enough to feel live. */
const POLL_MS = 3_000;

type Draft = {
  modelName: string;
  modelNumber: string;
  mpn: string;
  identifierKind: string;
  identifierValue: string;
  officialUrl: string;
  sourceUrl: string;
  documentTitle: string;
  documentText: string;
};

const EMPTY_DRAFT: Draft = {
  modelName: "",
  modelNumber: "",
  mpn: "",
  identifierKind: "",
  identifierValue: "",
  officialUrl: "",
  sourceUrl: "",
  documentTitle: "",
  documentText: "",
};

const IDENTIFIER_KINDS = [
  { value: "", label: "Not known" },
  { value: "gtin", label: "GTIN" },
  { value: "upc", label: "UPC" },
  { value: "ean", label: "EAN" },
  { value: "isbn", label: "ISBN" },
  { value: "asin", label: "ASIN" },
] as const;

const selectClass =
  "min-h-11 w-full rounded-control border border-blue-300 bg-paper px-3 text-body text-ink";

export function PreparationPanel({
  productId,
  initialRun,
  discoveryConfigured,
  justStarted = false,
}: {
  productId: string;
  initialRun: PreparationRunView | null;
  discoveryConfigured: boolean;
  /** Arrived here straight from Add Product, so the panel opens expanded. */
  justStarted?: boolean;
}) {
  const router = useRouter();
  const [run, setRun] = useState<PreparationRunView | null>(initialRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [openForm, setOpenForm] = useState<"identity" | "sources" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dismissed, setDismissed] = useState(false);

  const discovery = describeDiscovery(discoveryConfigured);
  /*
   * One key per product per browser, so pressing the button twice — or
   * pressing it, losing the answer and pressing it again — asks the server for
   * the same run rather than a second one. The server is the real defence: a
   * product may only have one live run at a time.
   */
  const startKey = useRef<string | null>(null);

  /** The latest run for this product, whatever state it is in. */
  const refresh = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      const response = await fetch(`/api/admin/products/${productId}/preparation`, {
        cache: "no-store",
      }).catch(() => null);
      if (!response) {
        // A lost connection is a lost connection, not a failed preparation:
        // the run carries on in the background either way.
        setOffline(true);
        return null;
      }
      setOffline(false);
      if (!response.ok) {
        if (!options.quiet) setError("Preparation could not be read just now.");
        return null;
      }
      const body = (await response.json().catch(() => ({}))) as { run?: PreparationRunView | null };
      setRun(body.run ?? null);
      return body.run ?? null;
    },
    [productId],
  );

  const stage = run?.stage ?? null;
  const polling = stage !== null && shouldKeepPolling(stage);

  // Rediscover on mount and keep asking while the run is still moving. The
  // effect never starts a run, so a remount cannot create one.
  useEffect(() => {
    if (!polling) return;
    let live = true;
    const timer = window.setInterval(() => {
      if (!live) return;
      if (document.visibilityState === "hidden") return;
      void refresh({ quiet: true });
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [polling, refresh]);

  // The editor was server-rendered before the run finished, so once it does
  // the page is asked for the content the run prepared.
  const settled = useRef(stage);
  useEffect(() => {
    if (settled.current === stage) return;
    const previous = settled.current;
    settled.current = stage;
    if (previous && stage && !shouldKeepPolling(stage) && stage !== "CANCELLED") router.refresh();
  }, [stage, router]);

  async function post(body: Record<string, unknown>, path: string) {
    setBusy(true);
    setError(null);
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    if (!response) {
      setOffline(true);
      setError("That did not reach the server. Check your connection and try again.");
      return false;
    }
    setOffline(false);
    const payload = (await response.json().catch(() => ({}))) as { run?: PreparationRunView; error?: string };
    if (!response.ok) {
      setError(payload.error ?? "That could not be done just now.");
      return false;
    }
    if (payload.run) setRun(payload.run);
    setOpenForm(null);
    setDraft(EMPTY_DRAFT);
    return true;
  }

  async function start() {
    startKey.current ??= crypto.randomUUID();
    setDismissed(false);
    await post({ requestKey: startKey.current }, `/api/admin/products/${productId}/preparation`);
  }

  async function act(action: "retry" | "cancel" | "continue", extra: Record<string, unknown> = {}) {
    if (!run) return;
    await post({ action, ...extra }, `/api/admin/products/${productId}/preparation/${run.id}`);
  }

  function submitIdentity() {
    const identity: Record<string, string> = {};
    const put = (key: string, value: string) => {
      if (value.trim()) identity[key] = value.trim();
    };
    put("modelName", draft.modelName);
    put("modelNumber", draft.modelNumber);
    put("mpn", draft.mpn);
    put("officialUrl", draft.officialUrl);
    if (draft.identifierKind) put(draft.identifierKind, draft.identifierValue);
    if (Object.keys(identity).length === 0) {
      setError("Fill in at least one of these before continuing.");
      return;
    }
    void act("continue", { identity });
  }

  function submitSources() {
    const extra: Record<string, unknown> = {};
    const urls: string[] = [];
    if (draft.officialUrl.trim()) extra.identity = { officialUrl: draft.officialUrl.trim() };
    if (draft.sourceUrl.trim()) urls.push(draft.sourceUrl.trim());
    if (urls.length > 0) extra.urls = urls;
    if (draft.documentText.trim()) {
      extra.document = {
        title: draft.documentTitle.trim() || "Product specification",
        content: draft.documentText,
        contentType: "text/plain",
      };
    }
    if (Object.keys(extra).length === 0) {
      setError("Add an address or paste the specification before continuing.");
      return;
    }
    void act("continue", extra);
  }

  function openSection(section: string) {
    window.dispatchEvent(new CustomEvent("product-editor:open", { detail: section }));
  }

  // ------------------------------------------------------------------ views

  if (!run) {
    return (
      <StartCard productId={productId} discovery={discovery} onStart={() => void start()} busy={busy} error={error} />
    );
  }

  const phases = preparationPhases(run.stage, run.steps);
  const issues: PreparationIssue[] = [
    ...run.review.map(describeIssue),
    ...(run.failure ? [describeIssue(run.failure)] : []),
  ];
  const finishedWell = run.stage === "READY";

  if (finishedWell && dismissed) {
    return (
      <section className="admin-card flex flex-wrap items-center justify-between gap-3 p-3.5">
        <p className="text-meta text-ink/70">
          <span className="text-transit-green-text">✓</span> SeoPulse prepared this product.
        </p>
        <button
          type="button"
          onClick={() => setDismissed(false)}
          className="text-meta font-medium text-blue-600 hover:underline"
        >
          Show what it did
        </button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="preparation-heading"
      aria-busy={polling}
      className="admin-card flex flex-col gap-4"
      data-stage={run.stage}
      // The run's identity, so a test can prove a refresh came back to the
      // same run rather than to a second one started by the remount.
      data-run={run.id}
      data-testid="preparation-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="preparation-heading" className="admin-h2 text-body">
            {run.stage === "NEEDS_REVIEW" ? attentionSummary(run.review.length) : STAGE_LABEL[run.stage]}
          </h2>
          <p className="mt-0.5 max-w-[70ch] text-meta text-ink/65">{STAGE_SUMMARY[run.stage]}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {polling ? (
            <span className="inline-flex items-center gap-2 text-meta text-ink/65">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-brass-text"
              />
              {justStarted ? "Preparing…" : "Working…"}
            </span>
          ) : null}
          {finishedWell ? (
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-control px-2 py-1 text-meta font-medium text-blue-600 hover:bg-blue-50"
            >
              Hide
            </button>
          ) : null}
        </div>
      </div>

      {offline ? (
        <p className="text-meta text-brass-text">
          Manifest cannot reach the server right now. Preparation carries on in the background; this will catch up.
        </p>
      ) : null}

      <ol className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {phases.map((phase) => (
          <li key={phase.key} className="flex items-start gap-2 text-meta">
            <span
              aria-hidden="true"
              className={
                phase.state === "done"
                  ? "text-transit-green-text"
                  : phase.state === "partial"
                    ? "text-brass-text"
                    : phase.state === "active"
                      ? "text-blue-600"
                      : "text-ink/35"
              }
            >
              {phase.state === "done" ? "✓" : phase.state === "partial" ? "!" : phase.state === "active" ? "●" : "○"}
            </span>
            <span className="min-w-0">
              <span className={phase.state === "pending" ? "text-ink/45" : "text-ink/85"}>{phase.label}</span>
              <span className="sr-only">
                {phase.state === "done"
                  ? " — done"
                  : phase.state === "partial"
                    ? " — done, with limits"
                    : phase.state === "active"
                      ? " — in progress"
                      : " — not started"}
              </span>
              {phase.detail && phase.state !== "done" ? (
                <span className="block text-ink/55">{phase.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

      {issues.length > 0 ? (
        <ul className="flex flex-col gap-3 border-t border-blue-200 pt-4">
          {issues.map((issue) => (
            <li key={issue.code} className="flex flex-col gap-2 rounded-control border border-blue-200 bg-blue-50/40 p-3">
              <p className="text-body font-medium text-ink">{issue.title}</p>
              <p className="max-w-[70ch] text-meta text-ink/75">{issue.message}</p>
              <p className="max-w-[70ch] text-meta text-ink/60">{issue.remedy}</p>
              {issue.comparison ? <IdentityComparison comparison={issue.comparison} /> : null}
              <div className="flex flex-wrap gap-2">
                {issue.actions.map((action) => (
                  <IssueButton
                    key={action}
                    label={issue.comparison ? MISMATCH_ACTION_LABEL[action] : undefined}
                    action={action}
                    productId={productId}
                    busy={busy}
                    onOpenForm={(form) => {
                      setError(null);
                      setOpenForm((current) => (current === form ? null : form));
                    }}
                    onRecheck={() => void act("continue")}
                    onRetry={() => void act("retry")}
                    onSection={openSection}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {openForm === "identity" ? (
        <IdentityForm draft={draft} setDraft={setDraft} busy={busy} onSubmit={submitIdentity} onCancel={() => setOpenForm(null)} />
      ) : null}

      {openForm === "sources" ? (
        <SourcesForm
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          discoveryHint={discovery.hint}
          onSubmit={submitSources}
          onCancel={() => setOpenForm(null)}
        />
      ) : null}

      {error ? (
        <p role="alert" className="text-meta text-stamp-red-text">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-blue-200 pt-3 text-meta">
        {polling ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("cancel")}
            className="font-medium text-blue-600 hover:underline disabled:opacity-60"
          >
            Stop preparing
          </button>
        ) : null}
        {run.stage === "CANCELLED" ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => void act("retry")}>
            Start again
          </Button>
        ) : null}
        {finishedWell ? (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void start()}>
            Run SeoPulse again
          </Button>
        ) : null}
        <Link
          href={`/admin/products/${productId}/intelligence`}
          className="text-blue-600 underline-offset-4 hover:underline"
        >
          View product intelligence
        </Link>
        {run.seoRunId ? (
          <a
            className="text-blue-600 underline-offset-4 hover:underline"
            href={`/api/admin/seo-pulse/runs/${run.seoRunId}/export?format=html`}
            target="_blank"
            rel="noopener"
          >
            View SeoPulse report
          </a>
        ) : null}
      </div>
    </section>
  );
}

// -------------------------------------------------------------- sub-views

function StartCard({
  productId,
  discovery,
  onStart,
  busy,
  error,
}: {
  productId: string;
  discovery: ReturnType<typeof describeDiscovery>;
  onStart: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <section aria-labelledby="preparation-heading" className="admin-card flex flex-col gap-3" data-testid="preparation-start">
      <div>
        <h2 id="preparation-heading" className="admin-h2 text-body">
          Research &amp; Prepare with SeoPulse
        </h2>
        <p className="mt-0.5 max-w-[70ch] text-meta text-ink/65">
          Manifest researches this product, checks what it finds against trusted sources, and prepares the description
          and search wording. You review only what it asks about.
        </p>
      </div>
      <p
        className={`flex items-center gap-2 text-meta ${
          discovery.available ? "text-transit-green-text" : "text-brass-text"
        }`}
      >
        <span aria-hidden="true">{discovery.available ? "✓" : "!"}</span>
        {discovery.label}
      </p>
      {error ? (
        <p role="alert" className="text-meta text-stamp-red-text">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" size="sm" disabled={busy} onClick={onStart}>
          {busy ? "Starting…" : "Research & Prepare with SeoPulse"}
        </Button>
        <Link
          href={`/admin/products/${productId}/intelligence`}
          className="text-meta text-blue-600 underline-offset-4 hover:underline"
        >
          View product intelligence
        </Link>
      </div>
    </section>
  );
}

const ACTION_LABEL: Record<IssueAction, string> = {
  identity: "Provide missing information",
  sources: "Add a source",
  intelligence: "View sources & decide",
  specifications: "Add specifications",
  recheck: "Check again",
  retry: "Try again",
  manual: "Continue manually",
};

/** A page about a different product asks different things of the same buttons. */
const MISMATCH_ACTION_LABEL: Partial<Record<IssueAction, string>> = {
  identity: "Correct product identity",
  sources: "Use another source",
};

/**
 * What the product is recorded as beside what the page says it is. Identifiers
 * only, and the page's address, so a person can open it and judge.
 */
function IdentityComparison({ comparison }: { comparison: NonNullable<PreparationIssue["comparison"]> }) {
  const side = (title: string, rows: { label: string; values: string[] }[]) => (
    <div className="min-w-0 flex-1">
      <p className="text-meta font-medium text-ink/75">{title}</p>
      {rows.length === 0 ? (
        <p className="text-meta text-ink/55">No identifiers.</p>
      ) : (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta">
          {rows.map((row) => (
            <Fragment key={row.label}>
              <dt className="text-ink/55">{row.label}</dt>
              <dd className="break-words text-ink">{row.values.join(", ")}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-3 rounded-control border border-blue-200 bg-paper p-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        {side("Recorded for this product", comparison.recorded)}
        {side("Found on the page", comparison.found)}
      </div>
      {comparison.url ? (
        <a
          href={comparison.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-meta text-blue-600 underline underline-offset-2"
        >
          {comparison.url}
        </a>
      ) : null}
    </div>
  );
}

function IssueButton({
  label: labelOverride,
  action,
  productId,
  busy,
  onOpenForm,
  onRecheck,
  onRetry,
  onSection,
}: {
  label?: string;
  action: IssueAction;
  productId: string;
  busy: boolean;
  onOpenForm: (form: "identity" | "sources") => void;
  onRecheck: () => void;
  onRetry: () => void;
  onSection: (section: string) => void;
}) {
  const label = labelOverride ?? ACTION_LABEL[action];

  if (action === "intelligence") {
    return (
      <Link
        href={`/admin/products/${productId}/intelligence`}
        className="inline-flex min-h-9 items-center rounded-control border border-blue-300 bg-paper px-3 text-meta font-medium text-blue-600 hover:bg-blue-50"
      >
        {label}
      </Link>
    );
  }

  const onClick =
    action === "identity"
      ? () => onOpenForm("identity")
      : action === "sources"
        ? () => onOpenForm("sources")
        : action === "specifications"
          ? () => onSection("information")
          : action === "recheck"
            ? onRecheck
            : action === "retry"
              ? onRetry
              : () => onSection("basics");

  return (
    <Button type="button" size="sm" variant={action === "manual" ? "quiet" : "secondary"} disabled={busy} onClick={onClick}>
      {label}
    </Button>
  );
}

function IdentityForm({
  draft,
  setDraft,
  busy,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  setDraft: (update: (current: Draft) => Draft) => void;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-4 rounded-control border border-blue-200 p-3"
      noValidate
    >
      <p className="text-meta font-medium text-ink">Tell Manifest which product this is</p>
      <Field
        label="Model"
        name="prep-modelName"
        value={draft.modelName}
        onChange={(event) => setDraft((current) => ({ ...current, modelName: event.target.value }))}
      />
      <Field
        label="Model number"
        name="prep-modelNumber"
        value={draft.modelNumber}
        onChange={(event) => setDraft((current) => ({ ...current, modelNumber: event.target.value }))}
      />
      <Field
        label="Manufacturer part number (MPN)"
        name="prep-mpn"
        value={draft.mpn}
        onChange={(event) => setDraft((current) => ({ ...current, mpn: event.target.value }))}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex w-full flex-col gap-2 sm:w-44">
          <label htmlFor="prep-identifierKind" className="text-meta font-medium text-ink">
            Barcode type
          </label>
          <select
            id="prep-identifierKind"
            value={draft.identifierKind}
            onChange={(event) => setDraft((current) => ({ ...current, identifierKind: event.target.value }))}
            className={selectClass}
          >
            {IDENTIFIER_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1">
          <Field
            label="Barcode number"
            name="prep-identifierValue"
            disabled={!draft.identifierKind}
            value={draft.identifierValue}
            onChange={(event) => setDraft((current) => ({ ...current, identifierValue: event.target.value }))}
          />
        </div>
      </div>
      <Field
        label="Official product URL"
        name="prep-officialUrl"
        type="url"
        placeholder="https://"
        value={draft.officialUrl}
        onChange={(event) => setDraft((current) => ({ ...current, officialUrl: event.target.value }))}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Save and continue"}
        </Button>
        <Button type="button" size="sm" variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SourcesForm({
  draft,
  setDraft,
  busy,
  discoveryHint,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  setDraft: (update: (current: Draft) => Draft) => void;
  busy: boolean;
  discoveryHint: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-4 rounded-control border border-blue-200 p-3"
      noValidate
    >
      <div>
        <p className="text-meta font-medium text-ink">Give SeoPulse something to read</p>
        <p className="mt-0.5 max-w-[70ch] text-meta text-ink/65">{discoveryHint}</p>
      </div>
      <Field
        label="Official product URL"
        name="prep-source-officialUrl"
        type="url"
        placeholder="https://"
        value={draft.officialUrl}
        onChange={(event) => setDraft((current) => ({ ...current, officialUrl: event.target.value }))}
        hint="The manufacturer's own page for this product."
      />
      <Field
        label="Additional source URL"
        name="prep-source-url"
        type="url"
        placeholder="https://"
        value={draft.sourceUrl}
        onChange={(event) => setDraft((current) => ({ ...current, sourceUrl: event.target.value }))}
        hint="Optional. Another page that describes this exact product."
      />
      <Field
        label="Document name"
        name="prep-document-title"
        value={draft.documentTitle}
        onChange={(event) => setDraft((current) => ({ ...current, documentTitle: event.target.value }))}
        hint="Optional. What the pasted text is, such as “Manufacturer specification sheet”."
      />
      <div className="flex flex-col gap-2">
        <label htmlFor="prep-document-text" className="text-meta font-medium text-ink">
          Paste product specification or document text
        </label>
        <textarea
          id="prep-document-text"
          rows={6}
          value={draft.documentText}
          onChange={(event) => setDraft((current) => ({ ...current, documentText: event.target.value }))}
          className="rounded-control border border-blue-300 bg-paper p-3 text-body text-ink"
        />
        <p className="text-meta text-ink/70">
          Text only. Copy the specification out of the PDF or the page and paste it here — Manifest does not read
          attached files or photographs of a specification.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Save and continue"}
        </Button>
        <Button type="button" size="sm" variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
