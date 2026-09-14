"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, buttonClass } from "./button";
import { Field } from "./field";
import { AuthDivider, GoogleButton, GoogleMark } from "./google-button";
import { IconAlert, IconClose, IconUser } from "./icons";

type Mode = "signin" | "signup" | "code";

const GOOGLE_UNAVAILABLE =
  "Google sign-in isn't switched on yet. Use your email for now.";

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
 * transitions on `.auth-dialog` in globals.css.
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

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
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
    `relative z-10 flex min-h-10 flex-1 items-center justify-center rounded-control text-meta font-semibold transition-colors duration-300 ${
      active ? "text-ink" : "text-ink/60 hover:text-ink"
    }`;

  const title =
    mode === "signup"
      ? "Create your account"
      : mode === "code"
        ? "One more step"
        : "Welcome back";

  const subtitle =
    mode === "signup"
      ? "Keep your preorders, wishlist and addresses in one place."
      : mode === "code"
        ? "Confirm it's you with your authenticator app."
        : "Sign in to track preorders and check out faster.";

  const googleLabel = mode === "signup" ? "Sign up with Google" : "Continue with Google";

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
        <span className="max-w-[9ch] truncate max-[419px]:sr-only sm:max-w-[12ch]">{label}</span>
      </button>

      <dialog
        ref={dialogRef}
        onClose={close}
        onCancel={close}
        // The dialog has no padding of its own, so a click whose target is the
        // dialog itself landed on the backdrop.
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        aria-labelledby="auth-dialog-title"
        aria-describedby="auth-dialog-subtitle"
        className="auth-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(27rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-[calc(var(--radius-media)+4px)] border border-ink/8 bg-paper p-0 text-ink shadow-[var(--shadow-float)]"
      >
        <div className="relative px-6 pb-6 pt-8 sm:px-8 sm:pb-8">
          <button
            type="button"
            onClick={close}
            className="absolute right-3 top-3 inline-flex size-10 items-center justify-center rounded-full text-ink/60 transition-[background-color,color,transform] duration-200 hover:rotate-90 hover:bg-ink/5 hover:text-ink"
          >
            <IconClose size={18} />
            <span className="sr-only">Close</span>
          </button>

          <div className="flex flex-col items-center text-center">
            <span className="auth-dialog-badge inline-flex size-14 items-center justify-center rounded-full bg-blue-50 text-blue-600 ring-8 ring-blue-50/50">
              <IconUser size={24} />
            </span>
            <h2 id="auth-dialog-title" className="mt-4 font-display text-h2">
              {title}
            </h2>
            <p id="auth-dialog-subtitle" className="mt-1 max-w-[34ch] text-meta text-ink/65">
              {subtitle}
            </p>
          </div>

          {mode !== "code" ? (
            <div className="relative mt-6 flex rounded-control bg-ink/5 p-1">
              {/* One pill slides under whichever tab is chosen. */}
              <span
                aria-hidden="true"
                className={`absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-control bg-paper shadow-[var(--shadow-raise)] transition-transform duration-300 ease-[var(--ease-out-quint)] ${
                  mode === "signup" ? "translate-x-full" : "translate-x-0"
                }`}
              />
              <button
                type="button"
                aria-pressed={mode === "signin"}
                className={tab(mode === "signin")}
                onClick={() => switchMode("signin")}
              >
                Sign in
              </button>
              <button
                type="button"
                aria-pressed={mode === "signup"}
                className={tab(mode === "signup")}
                onClick={() => switchMode("signup")}
              >
                Create account
              </button>
            </div>
          ) : null}

          {/* Keyed on the mode, so each switch replays the pane's entrance. */}
          <div key={mode} className="auth-dialog-pane">
            {mode !== "code" ? (
              <div className="mt-6 flex flex-col gap-5">
                {googleEnabled ? (
                  // Comes back to the page the dialog was opened on.
                  <GoogleButton next={pathname} label={googleLabel} />
                ) : (
                  // Without credentials the redirect has nowhere to go, so the
                  // shopper is told here rather than sent off the page.
                  <button
                    type="button"
                    onClick={() => setError(GOOGLE_UNAVAILABLE)}
                    className={buttonClass({
                      variant: "secondary",
                      size: "lg",
                      className: "w-full",
                    })}
                  >
                    <GoogleMark />
                    {googleLabel}
                  </button>
                )}
                <AuthDivider label="or use your email" />
              </div>
            ) : null}

            {mode === "signin" ? (
              <form onSubmit={onSignIn} className="mt-5 flex flex-col gap-5" noValidate>
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
              <form onSubmit={onSignUp} className="mt-5 flex flex-col gap-5" noValidate>
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
              <p className="mt-5 text-center text-meta text-ink/70">
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
          </div>
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
          className="auth-dialog-error flex items-start gap-2 rounded-card border border-stamp-red bg-stamp-red/5 p-3 text-meta text-stamp-red-text"
        >
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          {message}
        </p>
      ) : null}
    </div>
  );
}
