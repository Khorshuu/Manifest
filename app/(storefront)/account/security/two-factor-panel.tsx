"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";

type Status = {
  enabled: boolean;
  enrolling: boolean;
  remainingRecoveryCodes: number;
};

/**
 * Turning two-factor authentication on and off.
 *
 * The secret and the recovery codes are shown once, here, and never again:
 * they are stored hashed, so if this panel could show them a second time a
 * borrowed session would be enough to defeat the whole thing.
 */
export function TwoFactorPanel({ status }: { status: Status }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function post(body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    const response = await fetch("/api/account/two-factor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    setPending(false);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(payload.error ?? "Something went wrong. Try again.");
      return null;
    }

    return payload;
  }

  async function begin() {
    const payload = await post({ action: "begin" });
    if (!payload) return;

    setSecret(payload.enrollment.secret);
    setUri(payload.enrollment.uri);
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "");

    const payload = await post({ action: "confirm", code });
    if (!payload) return;

    setSecret(null);
    setUri(null);
    setCodes(payload.recoveryCodes);
    router.refresh();
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "");

    const payload = await post({ action: "disable", code });
    if (!payload) return;

    setCodes(null);
    router.refresh();
  }

  if (codes) {
    return (
      <div className="flex max-w-xl flex-col gap-4 border border-transit-green p-5">
        <h2 className="font-display text-h2 text-ink">
          Two-factor authentication is on
        </h2>
        <p className="max-w-[60ch] text-body text-ink/80">
          Save these recovery codes somewhere safe. Each one works once, and
          they are the only way back in if you lose your phone. They cannot be
          shown again.
        </p>

        <ul className="grid grid-cols-1 gap-2 font-mono text-body text-ink sm:grid-cols-2">
          {codes.map((code) => (
            <li key={code} className="border border-blue-300 px-3 py-2">
              {code}
            </li>
          ))}
        </ul>

        <div>
          <Button type="button" variant="secondary" onClick={() => setCodes(null)}>
            I have saved them
          </Button>
        </div>
      </div>
    );
  }

  if (status.enabled) {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <p className="text-body text-ink">
          Two-factor authentication is on. {status.remainingRecoveryCodes}{" "}
          recovery code
          {status.remainingRecoveryCodes === 1 ? "" : "s"} left.
        </p>

        <form onSubmit={disable} className="flex flex-col gap-4" noValidate>
          <Field
            label="Enter a current code to turn it off"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            hint="A recovery code works here too."
            required
          />

          <div aria-live="polite">
            {error ? (
              <p className="text-meta text-stamp-red-text">{error}</p>
            ) : null}
          </div>

          <div>
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? "Turning off…" : "Turn off two-factor authentication"}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  if (secret && uri) {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <h2 className="font-display text-h2 text-ink">Scan this</h2>
        <p className="max-w-[60ch] text-body text-ink/80">
          Add this to your authenticator app, then enter the code it shows. Most
          apps accept the key typed in by hand.
        </p>

        <div className="border border-blue-300 p-4">
          <p className="text-meta text-ink/70">Setup key</p>
          <p className="mt-1 break-all font-mono text-body text-ink">{secret}</p>
          <p className="mt-3 text-meta text-ink/70">Or this link</p>
          <p className="mt-1 break-all font-mono text-meta text-ink/70">{uri}</p>
        </div>

        <form onSubmit={confirm} className="flex flex-col gap-4" noValidate>
          <Field
            label="Code from the app"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />

          <div aria-live="polite">
            {error ? (
              <p className="text-meta text-stamp-red-text">{error}</p>
            ) : null}
          </div>

          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Checking…" : "Turn it on"}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <p className="max-w-[60ch] text-body text-ink/80">
        Two-factor authentication is off. With it on, signing in needs a code
        from your phone as well as your password.
      </p>

      <div aria-live="polite">
        {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
      </div>

      <div>
        <Button type="button" onClick={begin} disabled={pending}>
          {pending ? "Setting up…" : "Set up two-factor authentication"}
        </Button>
      </div>
    </div>
  );
}
