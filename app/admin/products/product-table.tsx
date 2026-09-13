"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Button, buttonClass } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { formatBdt } from "@/lib/money";
import { DEFAULT_FILTERS, type Filters, type Sort } from "./filters";
import { CategoryDialog, ConfirmDialog, RowMenu, type MenuGroup } from "./product-dialogs";

export type Inventory = "in_stock" | "low" | "out" | "none";

export type ProductRow = {
  id: string;
  title: string;
  slug: string;
  brand: string | null;
  sku: string | null;
  status: string;
  /** Shown to shoppers: a public status and not archived. */
  live: boolean;
  archived: boolean;
  searchable: boolean;
  categoryId: string | null;
  categoryName: string | null;
  variantCount: number;
  imageUrl: string | null;
  minPriceBdt: number | null;
  maxPriceBdt: number | null;
  stockOnHand: number | null;
  preorderRemaining: number | null;
  uncappedPreorders: number;
  inventory: Inventory;
  updatedAt: string;
  createdAt: string;
};

const LIVE_LABELS: Record<string, string> = {
  in_stock: "In stock",
  preorder_open: "Preorder open",
  preorder_closed: "Preorder closed",
  coming_soon: "Coming soon",
  discontinued: "Discontinued",
};

const INVENTORY: Record<Inventory, { label: string; tone: "positive" | "warning" | "negative" | "neutral" }> = {
  in_stock: { label: "In stock", tone: "positive" },
  low: { label: "Low stock", tone: "warning" },
  out: { label: "Out of stock", tone: "negative" },
  none: { label: "No variants", tone: "neutral" },
};

type Toast = {
  tone: "success" | "error";
  text: string;
  details?: string[];
  link?: { href: string; label: string };
};

type Pending =
  | { kind: "archive" | "delete" | "unpublish"; ids: string[] }
  | { kind: "category"; ids: string[] }
  | null;

type Failure = { label: string; hint: string };

/**
 * Admin → Products.
 *
 * Summary cards that double as filters, one toolbar of combinable filters, a
 * table on wide screens and cards on narrow ones. Every row keeps its next
 * step in plain sight — Edit always, Publish whenever the product is not yet
 * live — and the ⋮ menu holds the rest, grouped. Every write goes through the
 * same product API and permission check as the editor.
 */
export function ProductTable({
  rows,
  categories,
  initial,
}: {
  rows: ProductRow[];
  categories: { id: string; label: string }[];
  initial: Filters;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const deferredQuery = useDeferredValue(filters.q);

  // The filters live in the address, so a card or a link can open a view and
  // the browser's back button returns to it.
  useEffect(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value && value !== DEFAULT_FILTERS[key as keyof Filters]) params.set(key, value);
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, [filters]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const counts = useMemo(() => {
    const active = rows.filter((row) => !row.archived);
    return {
      all: active.length,
      published: active.filter((row) => row.live).length,
      drafts: active.filter((row) => !row.live).length,
      out: active.filter((row) => row.inventory === "out").length,
      low: active.filter((row) => row.inventory === "low").length,
      archived: rows.length - active.length,
    };
  }, [rows]);

  const visible = useMemo(() => {
    const term = deferredQuery.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (filters.status === "all" && row.archived) return false;
      if (filters.status === "published" && !row.live) return false;
      if (filters.status === "draft" && (row.live || row.archived)) return false;
      if (filters.status === "archived" && !row.archived) return false;
      if (filters.stock === "in_stock" && row.inventory !== "in_stock" && row.inventory !== "low") return false;
      if (filters.stock === "low" && row.inventory !== "low") return false;
      if (filters.stock === "out" && row.inventory !== "out") return false;
      if (filters.category && row.categoryId !== filters.category) return false;
      if (!term) return true;
      return [row.title, row.brand, row.sku, row.slug, row.id]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(term));
    });

    const stockOf = (row: ProductRow) =>
      row.uncappedPreorders > 0 ? Number.MAX_SAFE_INTEGER : (row.stockOnHand ?? 0) + (row.preorderRemaining ?? 0);
    return filtered.sort((a, b) => {
      switch (filters.sort) {
        case "created":
          return b.createdAt.localeCompare(a.createdAt);
        case "name_asc":
          return a.title.localeCompare(b.title);
        case "name_desc":
          return b.title.localeCompare(a.title);
        case "price_asc":
          return (a.minPriceBdt ?? Infinity) - (b.minPriceBdt ?? Infinity);
        case "price_desc":
          return (b.minPriceBdt ?? -Infinity) - (a.minPriceBdt ?? -Infinity);
        case "stock_asc":
          return stockOf(a) - stockOf(b);
        default:
          return b.updatedAt.localeCompare(a.updatedAt);
      }
    });
  }, [rows, deferredQuery, filters]);

  const filtered =
    filters.q !== "" ||
    filters.status !== "all" ||
    filters.stock !== "all" ||
    filters.category !== "";
  const chosen = visible.filter((row) => selected.has(row.id));
  const allChosen = visible.length > 0 && chosen.length === visible.length;
  const byId = new Map(rows.map((row) => [row.id, row]));

  // ---------------------------------------------------------------- writes

  async function send(url: string, method: string, body?: unknown) {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : {};
    return {
      ok: Boolean(response?.ok),
      error: (json.error as string | undefined) ?? (response ? undefined : "The server could not be reached."),
      failures: (json.failures as Failure[] | undefined) ?? [],
      json,
    };
  }

  const request = {
    publish: (id: string) => send(`/api/admin/products/${id}/publish`, "POST", {}),
    unpublish: (id: string) => send(`/api/admin/products/${id}`, "POST", { action: "unpublish" }),
    archive: (id: string) => send(`/api/admin/products/${id}`, "POST", { action: "archive" }),
    restore: (id: string) => send(`/api/admin/products/${id}`, "POST", { action: "restore" }),
    duplicate: (id: string) => send(`/api/admin/products/${id}`, "POST", { action: "duplicate" }),
    delete: (id: string) => send(`/api/admin/products/${id}`, "DELETE"),
    category: (id: string, categoryId: string) => send(`/api/admin/products/${id}`, "PATCH", { categoryId }),
    searchable: (id: string, searchable: boolean) => send(`/api/admin/products/${id}`, "PATCH", { searchable }),
  };

  const PAST: Record<string, string> = {
    publish: "published",
    unpublish: "moved back to draft",
    archive: "archived",
    restore: "restored as a draft",
    delete: "deleted",
    category: "moved",
    show: "shown in search",
    hide: "hidden from search",
  };

  /** Runs one action over several products, one request each, and reports. */
  async function runMany(
    kind: keyof typeof PAST,
    ids: string[],
    call: (id: string) => ReturnType<typeof send>,
  ) {
    setWorking(new Set(ids));
    setToast(null);
    let done = 0;
    const problems: string[] = [];
    for (const id of ids) {
      const result = await call(id);
      const title = byId.get(id)?.title ?? "A product";
      if (result.ok) done += 1;
      else if (result.failures.length > 0) {
        problems.push(`${title}: ${result.failures.map((failure) => failure.label.toLowerCase()).join(", ")}`);
      } else problems.push(`${title}: ${result.error ?? "could not be changed"}`);
    }
    setWorking(new Set());
    setSelected(new Set());
    const noun = (n: number) => `${n} product${n === 1 ? "" : "s"}`;
    setToast(
      problems.length === 0
        ? { tone: "success", text: `${noun(done)} ${PAST[kind]}.` }
        : {
            tone: "error",
            text: `${done > 0 ? `${noun(done)} ${PAST[kind]}. ` : ""}${noun(problems.length)} could not be ${PAST[kind]}:`,
            details: problems,
            link: ids.length === 1 ? { href: `/admin/products/${ids[0]}`, label: "Open the product to fix it" } : undefined,
          },
    );
    router.refresh();
  }

  async function duplicate(row: ProductRow) {
    setWorking(new Set([row.id]));
    const result = await request.duplicate(row.id);
    setWorking(new Set());
    if (!result.ok) {
      setToast({ tone: "error", text: result.error ?? "The product could not be copied." });
      return;
    }
    const copy = result.json.result as { id: string; title: string };
    setToast({
      tone: "success",
      text: `Copied as “${copy.title}”, a draft.`,
      link: { href: `/admin/products/${copy.id}`, label: "Open the copy" },
    });
    router.refresh();
  }

  function menuFor(row: ProductRow): MenuGroup[] {
    return [
      {
        label: "Manage",
        items: [
          { kind: "link", label: "Edit", href: `/admin/products/${row.id}` },
          { kind: "button", label: "Duplicate", onSelect: () => void duplicate(row) },
          { kind: "link", label: "Preview", href: `/products/${row.slug}?preview=1`, newTab: true },
        ],
      },
      {
        label: "Visibility",
        items: row.archived
          ? [{ kind: "button", label: "Restore as draft", onSelect: () => void runMany("restore", [row.id], request.restore) }]
          : [
              row.live
                ? { kind: "button", label: "Unpublish", onSelect: () => setPending({ kind: "unpublish", ids: [row.id] }) }
                : { kind: "button", label: "Publish now", onSelect: () => void runMany("publish", [row.id], request.publish) },
              { kind: "button", label: "Archive", onSelect: () => setPending({ kind: "archive", ids: [row.id] }) },
            ],
      },
      {
        label: "Catalog",
        items: [
          { kind: "button", label: "Change category", onSelect: () => setPending({ kind: "category", ids: [row.id] }) },
          { kind: "link", label: "Manage inventory", href: `/admin/products/${row.id}?section=pricing` },
          { kind: "link", label: "Variations", href: `/admin/products/${row.id}?section=variations` },
        ],
      },
      {
        label: "Danger zone",
        items: [{ kind: "button", label: "Delete", tone: "danger", onSelect: () => setPending({ kind: "delete", ids: [row.id] }) }],
      },
    ];
  }

  // ------------------------------------------------------------- rendering

  const priceText = (row: ProductRow) =>
    row.minPriceBdt === null
      ? "—"
      : row.maxPriceBdt !== null && row.maxPriceBdt !== row.minPriceBdt
        ? `${formatBdt(row.minPriceBdt)} – ${formatBdt(row.maxPriceBdt)}`
        : formatBdt(row.minPriceBdt);

  const stockDetail = (row: ProductRow) => {
    const parts: string[] = [];
    if (row.stockOnHand !== null) parts.push(`${row.stockOnHand} on hand`);
    if (row.preorderRemaining !== null) parts.push(`${row.preorderRemaining} places left`);
    if (row.uncappedPreorders > 0) parts.push("uncapped preorder");
    return parts.join(" · ");
  };

  const updatedText = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  function StatusCell({ row }: { row: ProductRow }) {
    if (row.archived) return <StatusBadge tone="neutral">Archived</StatusBadge>;
    if (row.live) {
      return (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge tone="positive">Published</StatusBadge>
          <span className="text-[0.6875rem] text-ink/70">{LIVE_LABELS[row.status] ?? row.status}</span>
        </span>
      );
    }
    return (
      <span className="flex flex-col items-start gap-0.5">
        <StatusBadge tone="warning">{row.status === "scheduled" ? "Scheduled" : "Draft"}</StatusBadge>
        <span className="text-[0.6875rem] text-ink/70">Not visible to customers</span>
      </span>
    );
  }

  function PrimaryActions({ row, compact }: { row: ProductRow; compact?: boolean }) {
    const busy = working.has(row.id);
    return (
      <div className={`flex items-center gap-1.5 ${compact ? "" : "justify-end"}`}>
        <Link href={`/admin/products/${row.id}`} className={buttonClass({ variant: "secondary", size: "sm", className: "!min-h-9" })}>
          Edit
        </Link>
        {!row.live && !row.archived ? (
          <Button
            type="button"
            size="sm"
            className="!min-h-9"
            disabled={busy}
            onClick={() => void runMany("publish", [row.id], request.publish)}
          >
            {busy ? "Publishing…" : "Publish"}
            <span className="sr-only"> {row.title}</span>
          </Button>
        ) : null}
        {row.live ? (
          <a
            href={`/products/${row.slug}`}
            target="_blank"
            rel="noopener"
            className={buttonClass({ variant: "quiet", size: "sm", className: "!min-h-9" })}
          >
            Preview<span className="sr-only"> {row.title}</span>
          </a>
        ) : null}
        <RowMenu label={row.title} groups={menuFor(row)} />
      </div>
    );
  }

  const cards: { key: string; label: string; value: number; active: boolean; apply: () => void; tone?: string }[] = [
    { key: "all", label: "All products", value: counts.all, active: filters.status === "all" && filters.stock === "all", apply: () => setFilters((c) => ({ ...c, status: "all", stock: "all" })) },
    { key: "published", label: "Published", value: counts.published, active: filters.status === "published" && filters.stock === "all", apply: () => setFilters((c) => ({ ...c, status: "published", stock: "all" })) },
    { key: "drafts", label: "Drafts", value: counts.drafts, active: filters.status === "draft", apply: () => setFilters((c) => ({ ...c, status: "draft", stock: "all" })), tone: "text-brass-text" },
    { key: "out", label: "Out of stock", value: counts.out, active: filters.stock === "out", apply: () => setFilters((c) => ({ ...c, status: "all", stock: "out" })), tone: "text-stamp-red-text" },
    { key: "low", label: "Low stock", value: counts.low, active: filters.stock === "low", apply: () => setFilters((c) => ({ ...c, status: "all", stock: "low" })), tone: "text-brass-text" },
  ];

  const selectLabel = "flex min-w-0 flex-col gap-1 text-[0.75rem] font-medium text-ink/70";

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No products yet"
        body="Add your first product: a name and a category are enough to start, and it stays a draft — invisible to customers — until you publish it."
        action={{ href: "/admin/products/new", label: "+ Add product" }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------------------------------------------- summary */}
      <div role="group" aria-label="Filter by status" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            aria-pressed={card.active}
            onClick={card.apply}
            className={`flex flex-col items-start rounded-card border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${
              card.active
                ? "border-blue-600 bg-blue-50 shadow-[inset_0_0_0_1px_var(--color-blue-600)]"
                : "border-blue-300/80 bg-paper hover:border-blue-500"
            }`}
          >
            <span className="admin-kpi-label">{card.label}</span>
            <span className={`admin-kpi-value ${card.value > 0 && card.tone ? card.tone : ""}`}>{card.value}</span>
          </button>
        ))}
      </div>

      {/* ---------------------------------------------------- toolbar */}
      <div className="admin-card grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,2fr)_repeat(4,minmax(0,1fr))_auto] lg:items-end">
        <label className={`${selectLabel} sm:col-span-2 lg:col-span-1`}>
          Search
          <input
            type="search"
            value={filters.q}
            onChange={(event) => set("q", event.target.value)}
            placeholder="Name, SKU or product ID"
            className="admin-input"
          />
        </label>
        <label className={selectLabel}>
          Status
          <select value={filters.status} onChange={(event) => set("status", event.target.value as Filters["status"])} className="admin-input">
            <option value="all">All (not archived)</option>
            <option value="published">Published</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived ({counts.archived})</option>
          </select>
        </label>
        <label className={selectLabel}>
          Inventory
          <select value={filters.stock} onChange={(event) => set("stock", event.target.value as Filters["stock"])} className="admin-input">
            <option value="all">All</option>
            <option value="in_stock">In stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
          </select>
        </label>
        <label className={selectLabel}>
          Category
          <select value={filters.category} onChange={(event) => set("category", event.target.value)} className="admin-input">
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label className={selectLabel}>
          Sort
          <select value={filters.sort} onChange={(event) => set("sort", event.target.value as Sort)} className="admin-input">
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="name_asc">Name A–Z</option>
            <option value="name_desc">Name Z–A</option>
            <option value="price_asc">Price low → high</option>
            <option value="price_desc">Price high → low</option>
            <option value="stock_asc">Stock low → high</option>
          </select>
        </label>
        <button
          type="button"
          disabled={!filtered && filters.sort === "updated"}
          onClick={() => setFilters(DEFAULT_FILTERS)}
          className="min-h-9 rounded-control px-2 text-meta font-medium text-blue-600 hover:bg-blue-50 disabled:text-ink/35 disabled:hover:bg-transparent"
        >
          Clear filters
        </button>
      </div>

      {/* ---------------------------------------------------- bulk bar */}
      <div aria-live="polite" className="flex min-h-10 flex-wrap items-center gap-2 text-meta">
        {chosen.length > 0 ? (
          <div className="flex w-full flex-wrap items-center gap-2 rounded-card border border-blue-600 bg-blue-50 px-3 py-2">
            <span className="font-semibold text-ink">{chosen.length} selected</span>
            <span aria-hidden="true" className="text-ink/30">|</span>
            <button type="button" className="admin-chip" disabled={working.size > 0} onClick={() => void runMany("publish", chosen.map((row) => row.id), request.publish)}>
              Publish
            </button>
            <button type="button" className="admin-chip" disabled={working.size > 0} onClick={() => setPending({ kind: "unpublish", ids: chosen.map((row) => row.id) })}>
              Unpublish
            </button>
            <button type="button" className="admin-chip" disabled={working.size > 0} onClick={() => setPending({ kind: "category", ids: chosen.map((row) => row.id) })}>
              Change category
            </button>
            <button type="button" className="admin-chip" disabled={working.size > 0} onClick={() => void runMany("show", chosen.map((row) => row.id), (id) => request.searchable(id, true))}>
              Show in search
            </button>
            <button type="button" className="admin-chip" disabled={working.size > 0} onClick={() => void runMany("hide", chosen.map((row) => row.id), (id) => request.searchable(id, false))}>
              Hide from search
            </button>
            <button type="button" className="admin-chip" disabled={working.size > 0} onClick={() => setPending({ kind: "archive", ids: chosen.map((row) => row.id) })}>
              Archive
            </button>
            <button type="button" className="admin-chip !border-stamp-red !text-stamp-red-text" disabled={working.size > 0} onClick={() => setPending({ kind: "delete", ids: chosen.map((row) => row.id) })}>
              Delete
            </button>
            <button type="button" className="ml-auto text-blue-600 hover:underline" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        ) : (
          <span className="text-ink/65">
            {visible.length} of {counts.all + counts.archived} shown
            {working.size > 0 ? " · working…" : ""}
          </span>
        )}
      </div>

      {toast ? (
        <div
          role={toast.tone === "error" ? "alert" : "status"}
          className={`flex items-start gap-3 rounded-card border px-4 py-3 text-meta ${
            toast.tone === "error" ? "border-stamp-red bg-stamp-red/5" : "border-transit-green bg-transit-green/5"
          }`}
        >
          <div className="min-w-0 flex-1">
            <p className={toast.tone === "error" ? "font-semibold text-stamp-red-text" : "font-semibold text-transit-green-text"}>
              {toast.text}
            </p>
            {toast.details?.length ? (
              <ul className="mt-1 list-disc pl-5 text-ink/80">
                {toast.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            ) : null}
            {toast.link ? (
              <Link href={toast.link.href} className="mt-1 inline-block font-medium text-blue-600 underline-offset-4 hover:underline">
                {toast.link.label} →
              </Link>
            ) : null}
          </div>
          <button type="button" onClick={() => setToast(null)} className="text-ink/70 hover:text-ink">
            <span aria-hidden="true">×</span>
            <span className="sr-only">Dismiss</span>
          </button>
        </div>
      ) : null}

      {/* ---------------------------------------------------- results */}
      {visible.length === 0 ? (
        <div className="admin-card flex flex-col items-start gap-2">
          <p className="text-body font-semibold text-ink">No products match these filters.</p>
          <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} className="text-meta font-medium text-blue-600 hover:underline">
            Clear filters
          </button>
        </div>
      ) : (
        <>
          {/* Wide screens: the table. */}
          <div className="admin-card relative hidden overflow-x-auto p-0 md:block">
            <table className="admin-table min-w-[980px]">
              <caption className="sr-only">Products</caption>
              <thead>
                <tr>
                  <th scope="col" className="w-9">
                    <input
                      type="checkbox"
                      checked={allChosen}
                      onChange={() => setSelected(allChosen ? new Set() : new Set(visible.map((row) => row.id)))}
                      aria-label="Select all shown products"
                      className="size-4"
                    />
                  </th>
                  <th scope="col">Product</th>
                  <th scope="col">SKU</th>
                  <th scope="col">Category</th>
                  <th scope="col">Price</th>
                  <th scope="col">Inventory</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th scope="col" className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.id} aria-busy={working.has(row.id) || undefined} className={working.has(row.id) ? "opacity-60" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          })
                        }
                        aria-label={`Select ${row.title}`}
                        className="size-4"
                      />
                    </td>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <span className="size-10 shrink-0 overflow-hidden rounded-[6px] border border-blue-200 bg-blue-50">
                          {row.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={row.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
                          ) : null}
                        </span>
                        <span className="min-w-0">
                          <Link href={`/admin/products/${row.id}`} className="block max-w-[20rem] truncate font-semibold text-ink hover:text-blue-600">
                            {row.title}
                          </Link>
                          <span className="block truncate text-[0.75rem] text-ink/70">
                            {[row.brand, `${row.variantCount} variant${row.variantCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                            {!row.searchable ? <span className="font-semibold text-brass-text"> · hidden from search</span> : null}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap font-mono text-[0.75rem] text-ink/75">{row.sku ?? "—"}</td>
                    <td className="text-ink/75">{row.categoryName ?? "—"}</td>
                    <td className="whitespace-nowrap tabular-nums">{priceText(row)}</td>
                    <td className="whitespace-nowrap">
                      <span className="flex flex-col items-start gap-0.5">
                        <StatusBadge tone={INVENTORY[row.inventory].tone}>{INVENTORY[row.inventory].label}</StatusBadge>
                        {stockDetail(row) ? <span className="text-[0.6875rem] tabular-nums text-ink/70">{stockDetail(row)}</span> : null}
                      </span>
                    </td>
                    <td className="whitespace-nowrap">
                      <StatusCell row={row} />
                    </td>
                    <td className="whitespace-nowrap text-ink/70">{updatedText(row.updatedAt)}</td>
                    <td className="whitespace-nowrap">
                      <PrimaryActions row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Narrow screens: one card per product. */}
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Products">
            <li className="flex items-center gap-2 px-1 text-meta">
              <input
                id="select-all-mobile"
                type="checkbox"
                checked={allChosen}
                onChange={() => setSelected(allChosen ? new Set() : new Set(visible.map((row) => row.id)))}
                className="size-4"
              />
              <label htmlFor="select-all-mobile" className="text-ink/70">Select all shown</label>
            </li>
            {visible.map((row) => (
              <li key={row.id} className={`admin-card flex flex-col gap-3 p-3 ${working.has(row.id) ? "opacity-60" : ""}`}>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                    aria-label={`Select ${row.title}`}
                    className="mt-3 size-4 shrink-0"
                  />
                  <span className="size-14 shrink-0 overflow-hidden rounded-[6px] border border-blue-200 bg-blue-50">
                    {row.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={row.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link href={`/admin/products/${row.id}`} className="block font-semibold leading-snug text-ink">
                      {row.title}
                    </Link>
                    <p className="mt-0.5 text-[0.75rem] text-ink/70">
                      {[row.sku, row.categoryName, priceText(row)].filter(Boolean).join(" · ")}
                    </p>
                    <div className="mt-2 flex flex-wrap items-start gap-2">
                      <StatusCell row={row} />
                      <StatusBadge tone={INVENTORY[row.inventory].tone}>{INVENTORY[row.inventory].label}</StatusBadge>
                    </div>
                  </div>
                </div>
                <PrimaryActions row={row} compact />
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ---------------------------------------------------- dialogs */}
      {pending?.kind === "delete" ? (
        <ConfirmDialog
          title={`Delete ${pending.ids.length === 1 ? `“${byId.get(pending.ids[0])?.title}”` : `${pending.ids.length} products`}?`}
          body={
            <p>
              This cannot be undone. A product that has ever been ordered, reviewed or reserved is
              never deleted — you will be told, and can archive it instead.
            </p>
          }
          confirmLabel="Delete permanently"
          tone="danger"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const ids = pending.ids;
            setPending(null);
            void runMany("delete", ids, request.delete);
          }}
        />
      ) : null}
      {pending?.kind === "archive" ? (
        <ConfirmDialog
          title={`Archive ${pending.ids.length === 1 ? `“${byId.get(pending.ids[0])?.title}”` : `${pending.ids.length} products`}?`}
          body={<p>Archived products come off sale and out of the storefront. Nothing is deleted, and you can restore them as drafts.</p>}
          confirmLabel="Archive"
          tone="danger"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const ids = pending.ids;
            setPending(null);
            void runMany("archive", ids, request.archive);
          }}
        />
      ) : null}
      {pending?.kind === "unpublish" ? (
        <ConfirmDialog
          title={`Unpublish ${pending.ids.length === 1 ? `“${byId.get(pending.ids[0])?.title}”` : `${pending.ids.length} products`}?`}
          body={<p>They go back to draft and disappear from the storefront until published again.</p>}
          confirmLabel="Unpublish"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const ids = pending.ids;
            setPending(null);
            void runMany("unpublish", ids, request.unpublish);
          }}
        />
      ) : null}
      {pending?.kind === "category" ? (
        <CategoryDialog
          count={pending.ids.length}
          categories={categories}
          onCancel={() => setPending(null)}
          onApply={(categoryId) => {
            const ids = pending.ids;
            setPending(null);
            void runMany("category", ids, (id) => request.category(id, categoryId));
          }}
        />
      ) : null}
    </div>
  );
}
