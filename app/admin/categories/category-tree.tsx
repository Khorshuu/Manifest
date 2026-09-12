"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { slugify } from "@/lib/slug";

export type TreeNode = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  depth: number;
  sortOrder: number;
  /** Products filed directly here, drafts included. */
  total: number;
  live: number;
  /** Products in this category and everything beneath it. */
  subtreeTotal: number;
  childCount: number;
};

/**
 * The category tree as staff work on it: every shelf with how many products
 * sit on it, open or folded, with rename, move and delete in place. Delete is
 * refused by the server while anything is filed in or under a category, and
 * the reason is shown here.
 */
export function CategoryTree({
  nodes,
  parents,
}: {
  /** Depth-first, so a child always follows its parent. */
  nodes: TreeNode[];
  parents: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A node is hidden when any ancestor is folded.
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  const hidden = (node: TreeNode) => {
    let parent = node.parentId;
    while (parent) {
      if (folded.has(parent)) return true;
      parent = parentOf.get(parent) ?? null;
    }
    return false;
  };

  const [addingUnder, setAddingUnder] = useState<string | null>(null);

  /** Swaps a category with its neighbour, renumbering the siblings in order. */
  async function move(node: TreeNode, direction: -1 | 1) {
    const siblings = nodes.filter((candidate) => candidate.parentId === node.parentId);
    const index = siblings.findIndex((candidate) => candidate.id === node.id);
    const target = index + direction;
    if (target < 0 || target >= siblings.length) return;
    const order = [...siblings];
    [order[index], order[target]] = [order[target], order[index]];
    setBusy(true);
    setError(null);
    for (const [position, sibling] of order.entries()) {
      if (sibling.sortOrder === position) continue;
      const response = await fetch(`/api/admin/categories/${sibling.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: sibling.name,
          slug: sibling.slug,
          parentId: sibling.parentId,
          sortOrder: position,
        }),
      }).catch(() => null);
      if (!response?.ok) {
        setError("The order could not be saved. Try again.");
        break;
      }
    }
    setBusy(false);
    router.refresh();
  }

  async function addSub(parent: TreeNode, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const response = await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed, slug: slugify(trimmed), parentId: parent.id }),
    }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => ({})) : {};
      setError(payload.error ?? "Something went wrong. Try again.");
      return;
    }
    setAddingUnder(null);
    setFolded((current) => {
      const next = new Set(current);
      next.delete(parent.id);
      return next;
    });
    setMessage(`“${trimmed}” added inside ${parent.name}.`);
    router.refresh();
  }

  async function send(method: "PATCH" | "DELETE", id: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const response = await fetch(`/api/admin/categories/${id}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => ({})) : {};
      setError(payload.error ?? "Something went wrong. Try again.");
      return false;
    }
    router.refresh();
    return true;
  }

  /*
   * One category's pieces, written once and drawn twice: as a row in the
   * table on a wide screen, and as a card on a phone. The table's four
   * columns cannot be squeezed into 390px — the actions column ended up a
   * clipped vertical stack with "Delete" cut in half — and duplicating the
   * markup rather than the components would leave two places to keep in step.
   */
  function NodeName({ node }: { node: TreeNode }) {
    return (
      <>
        {node.childCount > 0 ? (
          <button
            type="button"
            aria-expanded={!folded.has(node.id)}
            onClick={() =>
              setFolded((current) => {
                const next = new Set(current);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                return next;
              })
            }
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-ink/70 hover:bg-blue-50"
          >
            <span aria-hidden="true">{folded.has(node.id) ? "▸" : "▾"}</span>
            <span className="sr-only">
              {folded.has(node.id) ? `Show inside ${node.name}` : `Fold ${node.name}`}
            </span>
          </button>
        ) : (
          <span aria-hidden="true" className="inline-block size-6 shrink-0 text-center text-ink/25">
            ·
          </span>
        )}
        <span className={node.depth === 0 ? "font-semibold text-ink" : "text-ink"}>
          {node.name}
        </span>
        <span className="hidden font-mono text-[0.6875rem] text-ink/70 sm:inline">
          /{node.slug}
        </span>
        {node.childCount > 0 ? (
          <span className="text-[0.6875rem] text-ink/70">{node.childCount} sub</span>
        ) : null}
      </>
    );
  }

  function NodeActions({ node }: { node: TreeNode }) {
    return (
      <>
        <button
          type="button"
          disabled={busy}
          onClick={() => move(node, -1)}
          className="inline-flex size-7 items-center justify-center rounded text-blue-600 hover:bg-blue-50 disabled:opacity-40"
        >
          <span aria-hidden="true">↑</span>
          <span className="sr-only">Move {node.name} up</span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => move(node, 1)}
          className="inline-flex size-7 items-center justify-center rounded text-blue-600 hover:bg-blue-50 disabled:opacity-40"
        >
          <span aria-hidden="true">↓</span>
          <span className="sr-only">Move {node.name} down</span>
        </button>
        <span aria-hidden="true" className="px-1.5 text-ink/25">|</span>
        <button
          type="button"
          onClick={() => setAddingUnder(addingUnder === node.id ? null : node.id)}
          className="font-semibold text-blue-600 hover:underline"
        >
          + Sub
        </button>
        <span aria-hidden="true" className="px-1.5 text-ink/25">|</span>
        <Link
          href={`/categories/${node.slug}`}
          target="_blank"
          className="text-blue-600 hover:underline"
        >
          View
        </Link>
        <span aria-hidden="true" className="px-1.5 text-ink/25">|</span>
        <button
          type="button"
          onClick={() => setEditing(node.id)}
          className="font-semibold text-blue-600 hover:underline"
        >
          Edit
        </button>
        <span aria-hidden="true" className="px-1.5 text-ink/25">|</span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(`Delete “${node.name}”? This cannot be undone.`)) return;
            if (await send("DELETE", node.id)) setMessage(`“${node.name}” deleted.`);
          }}
          className="text-stamp-red-text hover:underline disabled:opacity-50"
          title={
            node.subtreeTotal > 0 || node.childCount > 0
              ? "Move its products and subcategories first"
              : undefined
          }
        >
          Delete
        </button>
      </>
    );
  }

  function EditForm({ node }: { node: TreeNode }) {
    return (
      <form
        className="flex flex-wrap items-end gap-2 py-1"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const parent = String(form.get("parentId") ?? "");
          const ok = await send("PATCH", node.id, {
            name: String(form.get("name") ?? ""),
            slug: String(form.get("slug") ?? ""),
            parentId: parent || null,
          });
          if (ok) {
            setEditing(null);
            setMessage("Category saved.");
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
          Name
          <input name="name" defaultValue={node.name} required className="admin-input w-48 max-w-full" />
        </label>
        <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
          Address
          <input
            name="slug"
            defaultValue={node.slug}
            required
            className="admin-input w-44 max-w-full font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
          Inside
          <select name="parentId" defaultValue={node.parentId ?? ""} className="admin-input w-52 max-w-full">
            <option value="">Top level</option>
            {parents
              .filter((parent) => parent.id !== node.id)
              .map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.label}
                </option>
              ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="min-h-9 rounded-control bg-blue-600 px-3 text-meta font-semibold text-paper"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(null)}
          className="min-h-9 px-2 text-meta text-blue-600"
        >
          Cancel
        </button>
      </form>
    );
  }

  function AddSubForm({ node }: { node: TreeNode }) {
    return (
      <form
        className="flex flex-wrap items-end gap-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          void addSub(node, String(new FormData(event.currentTarget).get("name") ?? ""));
        }}
      >
        <label className="flex flex-col gap-1 text-[0.75rem] text-ink/70">
          New sub-category inside {node.name}
          <input
            name="name"
            required
            autoFocus
            placeholder="e.g. Headphones"
            className="admin-input w-56 max-w-full"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="min-h-9 rounded-control bg-blue-600 px-3 text-meta font-semibold text-paper"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => setAddingUnder(null)}
          className="min-h-9 px-2 text-meta text-blue-600"
        >
          Cancel
        </button>
      </form>
    );
  }

  const visible = nodes.filter((node) => !hidden(node));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-meta" aria-live="polite">
        <button
          type="button"
          className="admin-chip"
          onClick={() =>
            setFolded(new Set(nodes.filter((n) => n.childCount > 0).map((n) => n.id)))
          }
        >
          Fold all
        </button>
        <button type="button" className="admin-chip" onClick={() => setFolded(new Set())}>
          Unfold all
        </button>
        {error ? <span className="text-stamp-red-text">{error}</span> : null}
        {message ? <span className="text-transit-green-text">{message}</span> : null}
      </div>

      {/* Narrow screens: one card per category, indented by its depth. */}
      <ul className="flex flex-col gap-1.5 md:hidden" aria-label="Categories">
        {visible.map((node) => (
          <li
            key={node.id}
            className="rounded-card border border-blue-200 p-2.5"
            style={{ marginLeft: Math.min(node.depth, 3) * 14 }}
          >
            {editing === node.id ? (
              <EditForm node={node} />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <NodeName node={node} />
                </div>
                <p className="mt-1 pl-6 text-[0.75rem] tabular-nums text-ink/70">
                  {node.total} here
                  {node.total > node.live ? ` (${node.live} live)` : ""} ·{" "}
                  {node.subtreeTotal} including below
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1 pl-6 text-[0.75rem]">
                  <NodeActions node={node} />
                </div>
              </>
            )}
            {addingUnder === node.id ? (
              <div className="mt-2 border-t border-blue-200 pt-2">
                <AddSubForm node={node} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="relative hidden overflow-x-auto md:block">
        <table className="admin-table md:min-w-[620px]">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col" className="text-right">Products here</th>
              <th scope="col" className="text-right">Including below</th>
              <th scope="col" className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((node) =>
              editing === node.id ? (
                <tr key={node.id}>
                  <td colSpan={4}>
                    <div style={{ paddingLeft: node.depth * 20 }}>
                      <EditForm node={node} />
                    </div>
                  </td>
                </tr>
              ) : (
                <Fragment key={node.id}>
                  <tr>
                    <td>
                      <div
                        className="flex items-center gap-1.5"
                        style={{ paddingLeft: node.depth * 20 }}
                      >
                        <NodeName node={node} />
                      </div>
                    </td>
                    <td className="text-right tabular-nums">
                      {node.total}
                      {node.total > node.live ? (
                        <span className="text-ink/70"> ({node.live} live)</span>
                      ) : null}
                    </td>
                    <td className="text-right tabular-nums text-ink/70">{node.subtreeTotal}</td>
                    <td className="whitespace-nowrap text-right">
                      <NodeActions node={node} />
                    </td>
                  </tr>
                  {addingUnder === node.id ? (
                    <tr>
                      <td colSpan={4}>
                        <div style={{ paddingLeft: (node.depth + 1) * 20 }}>
                          <AddSubForm node={node} />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
