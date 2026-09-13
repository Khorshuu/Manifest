"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/button";

/**
 * The small interactive pieces the product list is built from: the row's
 * action menu, a confirmation dialog, and the change-category dialog. Each is
 * keyboard-operable — arrow keys in the menu, Escape to close, focus returned
 * to what opened it.
 */

export type MenuItem =
  | { kind: "link"; label: string; href: string; newTab?: boolean; tone?: "danger" }
  | { kind: "button"; label: string; onSelect: () => void; tone?: "danger"; disabled?: boolean };

export type MenuGroup = { label: string; items: MenuItem[] };

export function RowMenu({ label, groups }: { label: string; groups: MenuGroup[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const visible = groups.filter((group) => group.items.length > 0);

  // Fixed to the viewport so a scrolling table cannot clip it.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const height = menuRef.current?.offsetHeight ?? 320;
    const below = rect.bottom + 4 + height <= window.innerHeight;
    setPosition({
      top: below ? rect.bottom + 4 : Math.max(8, rect.top - height - 4),
      right: Math.max(8, window.innerWidth - rect.right),
    });
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (event: MouseEvent) => {
      if (
        !menuRef.current?.contains(event.target as Node) &&
        !buttonRef.current?.contains(event.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? items[0] : items.at(-1))?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  const itemClass = (tone?: "danger") =>
    `flex min-h-10 w-full items-center px-3 text-left text-[0.8125rem] outline-none focus-visible:bg-blue-50 hover:bg-blue-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${
      tone === "danger" ? "text-stamp-red-text" : "text-ink"
    }`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex size-9 items-center justify-center rounded-control border border-transparent text-ink/70 hover:border-blue-300 hover:bg-blue-50 hover:text-ink focus-visible:border-blue-500"
      >
        <span aria-hidden="true" className="text-[1.125rem] leading-none">⋮</span>
        <span className="sr-only">More actions for {label}</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${label}`}
          onKeyDown={onKeyDown}
          style={position ? { top: position.top, right: position.right } : { visibility: "hidden" }}
          className="fixed z-[80] w-56 overflow-hidden rounded-card border border-blue-300 bg-paper py-1 shadow-[var(--shadow-float)]"
        >
          {visible.map((group, groupIndex) => (
            <div key={group.label} role="group" aria-label={group.label} className={groupIndex > 0 ? "border-t border-blue-200 pt-1" : ""}>
              <p aria-hidden="true" className="px-3 pb-0.5 pt-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-ink/70">
                {group.label}
              </p>
              {group.items.map((item) =>
                item.kind === "link" ? (
                  <Link
                    key={item.label}
                    role="menuitem"
                    tabIndex={-1}
                    href={item.href}
                    target={item.newTab ? "_blank" : undefined}
                    rel={item.newTab ? "noopener" : undefined}
                    onClick={() => setOpen(false)}
                    className={itemClass(item.tone)}
                  >
                    {item.label}
                    {item.newTab ? <span aria-hidden="true" className="ml-auto text-ink/70">↗</span> : null}
                  </Link>
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    aria-disabled={item.disabled || undefined}
                    onClick={() => {
                      if (item.disabled) return;
                      setOpen(false);
                      item.onSelect();
                    }}
                    className={itemClass(item.tone)}
                  >
                    {item.label}
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Modal({
  labelledBy,
  onClose,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    panelRef.current?.querySelector<HTMLElement>("select, button, input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/35 p-4 sm:items-center" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="w-full max-w-md rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-float)]"
      >
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  tone = "primary",
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal labelledBy="confirm-title" onClose={onCancel}>
      <h2 id="confirm-title" className="admin-h2 text-body">{title}</h2>
      <div className="mt-2 text-meta text-ink/80">{body}</div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant={tone === "danger" ? "danger" : "primary"} size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function CategoryDialog({
  count,
  categories,
  onApply,
  onCancel,
}: {
  count: number;
  categories: { id: string; label: string }[];
  onApply: (categoryId: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(categories[0]?.id ?? "");
  return (
    <Modal labelledBy="category-title" onClose={onCancel}>
      <h2 id="category-title" className="admin-h2 text-body">
        Change category for {count} product{count === 1 ? "" : "s"}
      </h2>
      <label className="mt-3 flex flex-col gap-1 text-[0.75rem] font-medium text-ink/70">
        Move to
        <select value={value} onChange={(event) => setValue(event.target.value)} className="admin-input">
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-[0.75rem] text-ink/65">
        The product also appears on every shelf above the one chosen. Specifications the new
        category requires are checked when it moves.
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!value} onClick={() => onApply(value)}>
          Move
        </Button>
      </div>
    </Modal>
  );
}
