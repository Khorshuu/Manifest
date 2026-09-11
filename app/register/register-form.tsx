"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import { IconAlert } from "@/components/icons";

/**
 * Self-registration, through the same `/api/auth/register` endpoint and the
 * same schema the server validates with. The account is always a customer —
 * the endpoint rejects any other field — and it is signed in on success, so
 * the shopper lands back where they were with their name in the header.
 */
export function RegisterForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");

    if (password !== String(form.get("confirm") ?? "")) {
      setError("The two passwords do not match.");
      return;
    }

    setPending(true);

    const phone = String(form.get("phone") ?? "").trim();
    const lastName = String(form.get("lastName") ?? "").trim();

    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: form.get("firstName"),
        ...(lastName ? { lastName } : {}),
        email: form.get("email"),
        ...(phone ? { phone } : {}),
        password,
      }),
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

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="First name"
          name="firstName"
          autoComplete="given-name"
          required
          maxLength={60}
        />
        <Field
          label="Last name"
          name="lastName"
          autoComplete="family-name"
          maxLength={60}
        />
      </div>
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <Field
        label="Mobile number"
        name="phone"
        type="tel"
        autoComplete="tel"
        inputMode="tel"
        hint="Optional. For delivery updates, e.g. 01712345678."
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        hint="At least 10 characters."
      />
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
      />

      <div aria-live="polite">
        {error ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            className="flex items-start gap-2 rounded-card border border-stamp-red bg-stamp-red/5 p-3 text-meta text-stamp-red-text"
          >
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : null}
      </div>

      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Creating your account…" : "Create account"}
      </Button>
    </form>
  );
}
