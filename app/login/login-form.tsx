"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import { IconAlert } from "@/components/icons";

/**
 * A failed sign-in, shown as something that happened rather than as a line of
 * red text below the fields — and given focus, so someone using a keyboard or
 * a screen reader is told the attempt failed instead of being left at a form
 * that looks unchanged.
 */
function SignInError({ message }: { message: string | null }) {
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);

  return (
    <div aria-live="polite">
      {message ? (
        <p
          ref={ref}
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

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Set once the password is accepted and a code is owed. */
  const [needsCode, setNeedsCode] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(body.error ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    if (body.needsSecondFactor) {
      // Signed in as far as the password goes; the cookie authenticates
      // nothing until the code is accepted.
      setPending(false);
      setNeedsCode(true);
      return;
    }

    router.replace(redirectTo);
    router.refresh();
  }

  async function onSubmitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/two-factor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: form.get("code") }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      setPending(false);
      return;
    }

    router.replace(redirectTo);
    router.refresh();
  }

  if (needsCode) {
    return (
      <form onSubmit={onSubmitCode} className="flex flex-col gap-6" noValidate>
        <div>
          <h2 className="font-display text-h2 text-ink">One more step</h2>
          <p className="mt-2 max-w-[60ch] text-meta text-ink/70">
            Enter the six-digit code from your authenticator app. If you have
            lost your phone, one of your recovery codes works here too.
          </p>
        </div>

        <Field
          label="Code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
        />

        <SignInError message={error} />

        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? "Checking…" : "Continue"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      {/* Announced to screen readers as it appears, not just shown visually */}
      <SignInError message={error} />

      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
