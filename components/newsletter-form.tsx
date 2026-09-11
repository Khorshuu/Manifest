"use client";

import { useState, type FormEvent } from "react";
import { buttonClass } from "./button";
import { IconCheck } from "./icons";

/** The footer signup. One field, one answer, no account needed. */
export function NewsletterForm() {
  const [state, setState] = useState<"idle" | "pending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setState("pending");
    setError(null);

    const response = await fetch("/api/newsletter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setState("idle");
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }
    setState("done");
  }

  if (state === "done") {
    return (
      <p className="mt-4 flex items-center gap-2 text-meta font-medium text-transit-green-text">
        <IconCheck size={16} className="shrink-0" />
        You are on the list. We will write when new windows open.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-2" noValidate>
      <label htmlFor="newsletter-email" className="text-meta text-ink/70">
        {/* No "email" in this label: it sits on every page, and a form's own
            Email field must stay the only thing answering to that name. */}
        New preorder windows in your inbox. No more than once a week.
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="newsletter-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "newsletter-error" : undefined}
          className="min-h-11 min-w-0 flex-1 rounded-control border border-blue-300 bg-paper px-3 text-body text-ink"
        />
        <button
          type="submit"
          disabled={state === "pending"}
          className={buttonClass({ variant: "secondary", size: "md" })}
        >
          {state === "pending" ? "Signing up…" : "Sign up"}
        </button>
      </div>
      <div aria-live="polite">
        {error ? (
          <p id="newsletter-error" className="text-meta text-stamp-red-text">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
