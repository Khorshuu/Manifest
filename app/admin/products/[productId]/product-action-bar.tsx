"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonClass } from "@/components/button";
import { StatusBadge } from "@/components/status-badge";
import { ConfirmDialog, RowMenu, type MenuGroup } from "../product-dialogs";
import { FIX_TARGETS, openFix } from "./fix-targets";

/**
 * The product editor's persistent action bar.
 *
 * It says, at every scroll position, what state the product is in and what
 * happens next: a draft offers Save draft and Publish now; a live product
 * offers Update product; an archived one offers Restore. Publishing saves any
 * unsaved panel first, then runs the server's readiness checks — and when they
 * fail, lists each thing that needs attention with a link straight to it.
 *
 * It also guards against leaving with unsaved edits.
 */

type Failure = { id: string; label: string; hint: string };


const LIVE_LABELS: Record<string, string> = {
  in_stock: "In stock",
  preorder_open: "Preorder open",
  preorder_closed: "Preorder closed",
  coming_soon: "Coming soon",
  discontinued: "Discontinued",
};

function dirtyForms(): HTMLFormElement[] {
  return [...document.querySelectorAll<HTMLFormElement>('#product-editor form[data-dirty="true"]')];
}

function sectionOf(form: HTMLFormElement): string {
  return form.closest<HTMLElement>("[data-section-label]")?.dataset.sectionLabel ?? "a section";
}

export function ProductActionBar({
  productId,
  slug,
  title,
  status,
  live,
  archived,
  justCreated,
}: {
  productId: string;
  slug: string;
  title: string;
  status: string;
  live: boolean;
  archived: boolean;
  justCreated: boolean;
}) {
  const router = useRouter();
  const [unsaved, setUnsaved] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | "save" | "publish" | "other">(null);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(
    justCreated
      ? { tone: "success", text: "Draft created. It is not visible to customers yet — add photos, variations and a price, then press Publish now." }
      : null,
  );
  const [leaving, setLeaving] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "unpublish" | "archive" | "delete">(null);
  const skipGuard = useRef(false);

  const recount = useCallback(() => {
    setUnsaved([...new Set(dirtyForms().map(sectionOf))]);
  }, []);

  // Every save row announces its state when it mounts and whenever it
  // changes, so listening is enough — nothing needs counting up front.
  useEffect(() => {
    window.addEventListener("product-editor-dirty", recount);
    return () => window.removeEventListener("product-editor-dirty", recount);
  }, [recount]);

  // Leaving with unsaved edits: the browser's own prompt for a reload or a
  // closed tab, and ours — Stay, Leave, or Save — for a link inside the site.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (skipGuard.current || dirtyForms().length === 0) return;
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (skipGuard.current || dirtyForms().length === 0) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaving(url.pathname + url.search);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  /**
   * Submits every unsaved panel and waits until each has saved or failed.
   * Resolves true only when nothing is left unsaved.
   */
  const saveAll = useCallback(async (): Promise<boolean> => {
    const forms = dirtyForms();
    if (forms.length === 0) return true;
    await new Promise<void>((resolve) => {
      let settled = 0;
      const done = () => {
        settled += 1;
        if (settled >= forms.length) finish();
      };
      const finish = () => {
        window.removeEventListener("product-editor-saved", done);
        window.removeEventListener("product-editor-save-failed", done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 20_000);
      window.addEventListener("product-editor-saved", done);
      window.addEventListener("product-editor-save-failed", done);
      forms.forEach((form) => form.requestSubmit());
    });
    const left = dirtyForms();
    recount();
    if (left.length > 0) {
      setNotice({
        tone: "error",
        text: `Not saved: ${[...new Set(left.map(sectionOf))].join(", ")}. Open ${left.length === 1 ? "it" : "them"} to see what needs fixing.`,
      });
      return false;
    }
    return true;
  }, [recount]);

  // Other panels (SEO Pulse) ask for everything to be saved before they run.
  useEffect(() => {
    const onRequest = (event: Event) => {
      const done = (event as CustomEvent<(ok: boolean) => void>).detail;
      void saveAll().then((ok) => done?.(ok));
    };
    window.addEventListener("product-editor:save-request", onRequest);
    return () => window.removeEventListener("product-editor:save-request", onRequest);
  }, [saveAll]);

  async function onSave() {
    setBusy("save");
    setNotice(null);
    const ok = await saveAll();
    setBusy(null);
    if (ok) setNotice({ tone: "success", text: live ? "Product updated. Changes are live." : "Draft saved." });
  }

  async function onPublish() {
    setBusy("publish");
    setNotice(null);
    setFailures([]);
    if (!(await saveAll())) {
      setBusy(null);
      return;
    }
    const response = await fetch(`/api/admin/products/${productId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    setBusy(null);
    if (!response?.ok) {
      setFailures(Array.isArray(body.failures) ? body.failures : []);
      setNotice({ tone: "error", text: body.error ?? "The product could not be published. Try again." });
      return;
    }
    setNotice({ tone: "success", text: "Published. It is live on the storefront now." });
    router.refresh();
  }

  async function lifecycle(action: "unpublish" | "archive" | "restore" | "duplicate") {
    setBusy("other");
    setNotice(null);
    const response = await fetch(`/api/admin/products/${productId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    setBusy(null);
    if (!response?.ok) {
      setNotice({ tone: "error", text: body.error ?? "That did not work. Try again." });
      return;
    }
    if (action === "duplicate") {
      skipGuard.current = true;
      router.push(`/admin/products/${body.result.id}?created=copy`);
      return;
    }
    setNotice({
      tone: "success",
      text:
        action === "unpublish"
          ? "Unpublished. It is a draft again and hidden from customers."
          : action === "archive"
            ? "Archived. It is off sale; nothing was deleted."
            : "Restored as a draft.",
    });
    router.refresh();
  }

  async function onDelete() {
    setBusy("other");
    const response = await fetch(`/api/admin/products/${productId}`, { method: "DELETE" }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    setBusy(null);
    if (!response?.ok) {
      setNotice({ tone: "error", text: body.error ?? "The product could not be deleted." });
      return;
    }
    skipGuard.current = true;
    router.push("/admin/products?deleted=1");
  }

  const menu: MenuGroup[] = [
    {
      label: "Manage",
      items: [{ kind: "button", label: "Duplicate", onSelect: () => void lifecycle("duplicate") }],
    },
    {
      label: "Visibility",
      items: archived
        ? []
        : [
            ...(live ? [{ kind: "button" as const, label: "Unpublish", onSelect: () => setConfirm("unpublish") }] : []),
            { kind: "button" as const, label: "Archive", onSelect: () => setConfirm("archive") },
          ],
    },
    {
      label: "Danger zone",
      items: [{ kind: "button", label: "Delete", tone: "danger", onSelect: () => setConfirm("delete") }],
    },
  ];

  const state = archived
    ? { badge: <StatusBadge tone="neutral">Archived</StatusBadge>, text: "Off sale and hidden. Restore it to edit and publish again." }
    : live
      ? {
          badge: <StatusBadge tone="positive">Published</StatusBadge>,
          text: `Live on the storefront as “${LIVE_LABELS[status] ?? status}”.`,
        }
      : {
          badge: <StatusBadge tone="warning">{status === "scheduled" ? "Scheduled" : "Draft"}</StatusBadge>,
          text: "Not visible to customers.",
        };

  return (
    <div className="sticky top-0 z-30 -mx-4 border-b border-blue-300 bg-paper/95 px-4 py-2.5 shadow-[0_1px_2px_rgb(18_35_63/0.05)] backdrop-blur md:-mx-6 md:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* A real minimum width: with flex-1 alone the buttons squeezed this to
            nothing on a phone instead of wrapping onto their own line. */}
        <div className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-2">
          {state.badge}
          <p className="min-w-0 truncate text-meta text-ink/75">
            <span className="sr-only">{title}: </span>
            {state.text}
            {unsaved.length > 0 ? (
              <span className="ml-2 font-semibold text-brass-text">
                Unsaved: {unsaved.join(", ")}
              </span>
            ) : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/products/${slug}?preview=1`}
            target="_blank"
            rel="noopener"
            className={buttonClass({ variant: "quiet", size: "sm" })}
          >
            Preview <span aria-hidden="true">↗</span>
          </a>

          {archived ? (
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => void lifecycle("restore")}>
              Restore as draft
            </Button>
          ) : live ? (
            <Button type="button" size="sm" disabled={busy !== null || unsaved.length === 0} onClick={() => void onSave()}>
              {busy === "save" ? "Updating…" : "Update product"}
            </Button>
          ) : (
            <>
              <Button type="button" size="sm" variant="secondary" disabled={busy !== null || unsaved.length === 0} onClick={() => void onSave()}>
                {busy === "save" ? "Saving…" : "Save draft"}
              </Button>
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void onPublish()}>
                {busy === "publish" ? "Publishing…" : "Publish now"}
              </Button>
            </>
          )}

          <RowMenu label={title} groups={menu} />
        </div>
      </div>

      <div aria-live="polite">
        {notice ? (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={`mt-2 flex items-start gap-3 rounded-card border px-3 py-2 text-meta ${
              notice.tone === "error" ? "border-stamp-red bg-stamp-red/5" : "border-transit-green bg-transit-green/5"
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className={`font-semibold ${notice.tone === "error" ? "text-stamp-red-text" : "text-transit-green-text"}`}>
                {notice.text}
              </p>
              {failures.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {failures.map((failure) => (
                    <li key={failure.id} className="flex flex-wrap items-baseline gap-x-2 text-ink/85">
                      <span className="font-medium text-ink">{failure.label}.</span>
                      <span>{failure.hint}</span>
                      {FIX_TARGETS[failure.id] ? (
                        <button
                          type="button"
                          onClick={() => openFix(failure.id)}
                          className="font-semibold text-blue-600 underline-offset-4 hover:underline"
                        >
                          Fix →
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <button type="button" onClick={() => { setNotice(null); setFailures([]); }} className="text-ink/70 hover:text-ink">
              <span aria-hidden="true">×</span>
              <span className="sr-only">Dismiss</span>
            </button>
          </div>
        ) : null}
      </div>

      {leaving ? (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/35 p-4 sm:items-center">
          <div role="alertdialog" aria-modal="true" aria-labelledby="leave-title" className="w-full max-w-md rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-float)]">
            <h2 id="leave-title" className="admin-h2 text-body">You have unsaved changes</h2>
            <p className="mt-2 text-meta text-ink/80">Unsaved: {unsaved.join(", ")}.</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="secondary" autoFocus onClick={() => setLeaving(null)}>
                Stay
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                onClick={() => {
                  skipGuard.current = true;
                  const target = leaving;
                  setLeaving(null);
                  router.push(target);
                }}
              >
                Leave without saving
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={async () => {
                  const target = leaving;
                  setLeaving(null);
                  if (await saveAll()) {
                    skipGuard.current = true;
                    router.push(target);
                  }
                }}
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {confirm === "unpublish" ? (
        <ConfirmDialog
          title={`Unpublish “${title}”?`}
          body={<p>It goes back to draft and disappears from the storefront until you publish it again.</p>}
          confirmLabel="Unpublish"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void lifecycle("unpublish"); }}
        />
      ) : null}
      {confirm === "archive" ? (
        <ConfirmDialog
          title={`Archive “${title}”?`}
          body={<p>It comes off sale and out of the storefront. Nothing is deleted, and you can restore it as a draft.</p>}
          confirmLabel="Archive"
          tone="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void lifecycle("archive"); }}
        />
      ) : null}
      {confirm === "delete" ? (
        <ConfirmDialog
          title={`Delete “${title}” permanently?`}
          body={<p>This cannot be undone. If it has ever been ordered, reviewed or reserved it will not be deleted — archive it instead.</p>}
          confirmLabel="Delete permanently"
          tone="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void onDelete(); }}
        />
      ) : null}
    </div>
  );
}
