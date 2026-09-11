"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconUser } from "./icons";

/**
 * The signed-in account control in the storefront header: the shopper's name,
 * opening a short menu with their account pages and Sign out.
 *
 * A button and a panel, like the catalogue menu beside it — Escape, a click
 * outside, or arriving on a new page closes it.
 */
export function AccountMenu({ label, isStaff }: { label: string; isStaff: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const [pending, setPending] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpenedAt(null);
      buttonRef.current?.focus();
    }
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpenedAt(null);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  async function signOut() {
    setPending(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setOpenedAt(null);
    router.replace("/");
    router.refresh();
    setPending(false);
  }

  const close = () => setOpenedAt(null);
  const row =
    "flex min-h-11 w-full items-center px-4 text-left text-[0.875rem] text-ink transition-colors hover:bg-blue-50 hover:text-blue-600";

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpenedAt((current) => (current === pathname ? null : pathname))}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 font-semibold transition-colors hover:bg-[color:var(--head-ghost)]"
      >
        <IconUser size={18} className="shrink-0" />
        <span className="max-w-[9ch] truncate sm:max-w-[12ch]">{label}</span>
        <IconChevronDown
          size={14}
          className={`shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
        <span className="sr-only">, account menu</span>
      </button>

      <div
        id="account-menu"
        hidden={!open}
        className="animate-rise absolute right-0 top-[calc(100%+0.5rem)] z-50 w-56 overflow-hidden rounded-card border border-blue-300 bg-paper py-1.5 text-ink shadow-[var(--shadow-float)]"
      >
        <Link href="/account" onClick={close} className={row}>
          My account
        </Link>
        <Link href="/account/orders" onClick={close} className={row}>
          My orders
        </Link>
        <Link href="/account/wishlist" onClick={close} className={row}>
          Wishlist
        </Link>
        {isStaff ? (
          <Link href="/admin" onClick={close} className={row}>
            Admin
          </Link>
        ) : null}
        <div className="my-1.5 border-t border-blue-200" />
        <button
          type="button"
          onClick={signOut}
          disabled={pending}
          className={`${row} font-semibold text-stamp-red-text hover:text-stamp-red-text disabled:opacity-60`}
        >
          {pending ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
