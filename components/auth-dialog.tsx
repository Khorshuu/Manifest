"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { Field } from "./field";
import { AuthDivider, GoogleButton } from "./google-button";
import { IconAlert, IconUser } from "./icons";

type Mode = "signin" | "signup" | "code";

/**
 * Signing in without leaving the page (DECISIONS.md D-042).
 *
 * The same two endpoints the /login and /register pages post to, in a dialog
 * over whatever the shopper was already looking at — a product, a cart, a
 * half-read page — so signing in no longer costs them their place. Both pages
 * remain, and every server-side redirect still sends people there; this is an
 * additional way in, not a replacement.
 *
 * It is a native dialog element, so the browser supplies the modal behaviour
 * that is otherwise hand-written and usually wrong: focus stays inside it, the
 * page behind is inert, and Escape closes it.
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
  const router = useRouter();
  const pathname = usePathname();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("signin");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function close() {
    setOpen(false);
    setError(null);
    setPending(false);
  }

  /**
   * Signing in from a page keeps the shopper on it; the server components are
   * re-rendered because the session changed, which is what puts their name in
   * the header and their guest cart count in its place.
   */
  function finish() {
    close();
    setMode("signin");
    router.refresh();
  }

  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    return { ok: response.ok, body: parsed as Record<string, unknown> };
  }

  async function onSignIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const { ok, body } = await post("/api/auth/login", {
      email: form.get("email"),
      password: form.get("password"),
    });

    if (!ok) {
      setError((body.error as string) ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    if (body.needsSecondFactor) {
      // The cookie is set but pending: it authenticates nothing until the code
      // is proved, exactly as on the sign-in page.
      setPending(false);
      setMode("code");
      return;
    }

    finish();
  }

  async function onSignUp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const phone = String(form.get("phone") ?? "").trim();

    setPending(true);

    const { ok, body } = await post("/api/auth/register", {
      firstName: form.get("firstName"),
      email: form.get("email"),
      ...(phone ? { phone } : {}),
      password,
    });

    if (!ok) {
      setError((body.error as string) ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    finish();
  }

  async function onCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const { ok, body } = await post("/api/auth/two-factor", {
      code: form.get("code"),
    });

    if (!ok) {
      setError((body.error as string) ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    finish();
  }

  const tab = (active: boolean) =>
    `flex min-h-10 flex-1 items-center justify-center rounded-control text-meta font-semibold transition-colors ${
      active
        ? "bg-paper text-ink shadow-[var(--shadow-raise)]"
        : "text-ink/65 hover:text-ink"
    }`;

  const title =
    mode === "signup"
      ? "Create an account"
      : mode === "code"
        ? "One more step"
        : "Sign in";

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMode("signin");
          setOpen(true);
        }}
        className={triggerClassName}
      >
        <IconUser size={18} className="shrink-0" />
        <span className="max-w-[9ch] truncate sm:max-w-[12ch]">{label}</span>
      </button>

      <dialog
        ref={dialogRef}
        onClose={close}
        onCancel={close}
        aria-labelledby="auth-dialog-title"
        className="w-[min(28rem,calc(100vw-2rem))] rounded-card border border-ink/10 bg-paper p-0 text-ink shadow-[var(--shadow-raise)] backdrop:bg-ink/45 backdrop:backdrop-blur-[2px]"
      >
        <div className="p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <h2 id="auth-dialog-title" className="font-display text-h2">
              {title}
            </h2>
            <button
              type="button"
              onClick={close}
              className="-mr-2 -mt-2 inline-flex size-11 items-center justify-center rounded-control text-ink/60 transition-colors hover:bg-ink/5 hover:text-ink"
            >
              <span aria-hidden="true" className="text-h3 leading-none">
                &times;
              </span>
              <span className="sr-only">Close</span>
            </button>
          </div>

          {mode !== "code" ? (
            <div className="mt-5 flex rounded-control bg-ink/5 p-1">
              <button
                type="button"
                className={tab(mode === "signin")}
                onClick={() => {
                  setMode("signin");
                  setError(null);
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                className={tab(mode === "signup")}
                onClick={() => {
                  setMode("signup");
                  setError(null);
                }}
              >
                Create account
              </button>
            </div>
          ) : null}

          {googleEnabled && mode !== "code" ? (
            <div className="mt-6 flex flex-col gap-5">
              {/* Comes back to the page the dialog was opened on. */}
              <GoogleButton next={pathname} />
              <AuthDivider />
            </div>
          ) : null}

          {mode === "signin" ? (
            <form onSubmit={onSignIn} className="mt-6 flex flex-col gap-5" noValidate>
              <Field
                label="Email"
                name="email"
                id="auth-dialog-email"
                type="email"
                autoComplete="email"
                required
              />
              <Field
                label="Password"
                name="password"
                id="auth-dialog-password"
                type="password"
                autoComplete="current-password"
                required
              />
              <DialogError message={error} errorRef={errorRef} />
              <Button type="submit" size="lg" disabled={pending} className="w-full">
                {pending ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          ) : null}

          {mode === "signup" ? (
            <form onSubmit={onSignUp} className="mt-6 flex flex-col gap-5" noValidate>
              <Field
                label="First name"
                name="firstName"
                id="auth-dialog-first-name"
                autoComplete="given-name"
                required
                maxLength={60}
              />
              <Field
                label="Email"
                name="email"
                id="auth-dialog-signup-email"
                type="email"
                autoComplete="email"
                required
              />
              <Field
                label="Mobile number"
                name="phone"
                id="auth-dialog-phone"
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                hint="Optional. For delivery updates, e.g. 01712345678."
              />
              <Field
                label="Password"
                name="password"
                id="auth-dialog-signup-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                hint="At least 10 characters."
              />
              <DialogError message={error} errorRef={errorRef} />
              <Button type="submit" size="lg" disabled={pending} className="w-full">
                {pending ? "Creating…" : "Create account"}
              </Button>
            </form>
          ) : null}

          {mode === "code" ? (
            <form onSubmit={onCode} className="mt-6 flex flex-col gap-5" noValidate>
              <p className="max-w-[60ch] text-meta text-ink/70">
                Enter the six-digit code from your authenticator app. If you have
                lost your phone, one of your recovery codes works here too.
              </p>
              <Field
                label="Code"
                name="code"
                id="auth-dialog-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
              <DialogError message={error} errorRef={errorRef} />
              <Button type="submit" size="lg" disabled={pending} className="w-full">
                {pending ? "Checking…" : "Continue"}
              </Button>
            </form>
          ) : null}

          {mode === "signin" ? (
            <p className="mt-5 text-meta text-ink/70">
              Ordered without an account?{" "}
              <a
                href="/orders/lookup"
                className="text-blue-600 underline-offset-4 hover:underline"
              >
                Track it with your order number
              </a>
              .
            </p>
          ) : null}

          {mode === "signup" ? (
            <p className="mt-5 text-meta text-ink/70">
              An account keeps your preorders, your wishlist and your delivery
              addresses in one place.
            </p>
          ) : null}
        </div>
      </dialog>
    </>
  );
}

function DialogError({
  message,
  errorRef,
}: {
  message: string | null;
  errorRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <div aria-live="polite">
      {message ? (
        <p
          ref={errorRef}
          tabIndex={-1}
          className="flex items-start gap-2 rounded-card border border-stamp-red bg-stamp-red/5 p-3 text-meta text-stamp-red-text"
        >
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          {message}
        </p>
      ) : null}
    </div>
  );
}
