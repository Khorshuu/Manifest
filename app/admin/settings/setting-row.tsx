"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";

/**
 * One setting, saved on its own. A single form for all of them would mean one
 * rejected value discards every other edit.
 */
export function SettingRow({
  settingKey,
  label,
  hint,
  value,
  isDefault,
  canEdit,
}: {
  settingKey: string;
  label: string;
  hint: string;
  value: unknown;
  isDefault: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isNumber = typeof value === "number";
  const inputId = `setting-${settingKey}`;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);

    const raw = String(new FormData(event.currentTarget).get("value") ?? "");

    const response = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: settingKey,
        value: isNumber ? Number(raw) : raw,
      }),
    });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Try again.");
      return;
    }

    setSaved(true);
    router.refresh();
  }

  return (
    <li className="min-w-0 border-b border-blue-300 py-4">
      <form onSubmit={save} className="flex flex-wrap items-end gap-3" noValidate>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={inputId} className="text-meta font-medium text-ink">
            {label}
          </label>
          <input
            id={inputId}
            name="value"
            type={isNumber ? "number" : "text"}
            defaultValue={String(value)}
            disabled={!canEdit}
            className="min-h-11 w-full max-w-sm rounded-control border border-blue-300 bg-paper px-3 text-body text-ink disabled:opacity-60"
          />
          <p className="text-meta text-ink/70">
            {hint}
            {isDefault ? " Currently the built-in default." : ""}
          </p>
          <p className="font-mono text-meta text-ink/40">{settingKey}</p>
        </div>

        {canEdit ? (
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        ) : null}

        <span aria-live="polite" className="text-meta">
          {error ? (
            <span className="text-stamp-red">{error}</span>
          ) : saved ? (
            <span className="text-transit-green">Saved.</span>
          ) : null}
        </span>
      </form>
    </li>
  );
}
