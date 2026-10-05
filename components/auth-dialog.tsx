"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { IconUser } from "./icons";

export type AuthDialogMode = "signin" | "signup" | "code";

/*
 * The dialog's forms load when the shopper first reaches for the trigger, not
 * with every page: most visitors never sign in from the header, and a page
 * carried them all the same.
 */
const AuthDialogPanel = dynamic(() => import("./auth-dialog-panel"), { ssr: false });

/** Starts the download early; a failure here is retried by the press itself. */
function preloadPanel() {
  import("./auth-dialog-panel").catch(() => {});
}

/**
 * Signing in without leaving the page (DECISIONS.md D-042, D-050).
 *
 * The same two endpoints the /login and /register pages post to, in a dialog
 * over whatever the shopper was already looking at — a product, a cart, a
 * half-read page — so signing in no longer costs them their place. Both pages
 * remain, and every server-side redirect still sends people there; this is an
 * additional way in, not a replacement.
 *
 * It is a native dialog element, so the browser supplies the modal behaviour
 * that is otherwise hand-written and usually wrong: focus stays inside it, the
 * page behind is inert, and Escape closes it. The entrance and exit are CSS
 * transitions on `.auth-dialog` in globals.css. The dialog itself is
 * components/auth-dialog-panel.tsx.
 */
export function AuthDialog({
  googleEnabled,
  triggerClassName = "",
  label = "Sign in",
}: {
  googleEnabled: boolean;
  triggerClassName?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AuthDialogMode>("signin");
  /** Mounted from the first press on, so closing can play its transition. */
  const [wanted, setWanted] = useState(false);

  return (
    <>
      <button
        type="button"
        // Fetched as the pointer arrives or the trigger takes focus, so the
        // dialog is usually there by the time the press lands.
        onPointerEnter={preloadPanel}
        onFocus={preloadPanel}
        onClick={() => {
          setMode("signin");
          setOpen(true);
          setWanted(true);
        }}
        className={triggerClassName}
      >
        <IconUser size={18} className="shrink-0" />
        <span className="max-w-[9ch] truncate max-[419px]:sr-only sm:max-w-[12ch]">{label}</span>
      </button>

      {wanted ? (
        <AuthDialogPanel
          googleEnabled={googleEnabled}
          open={open}
          onClose={() => setOpen(false)}
          mode={mode}
          setMode={setMode}
        />
      ) : null}
    </>
  );
}
