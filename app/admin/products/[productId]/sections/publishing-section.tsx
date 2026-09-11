"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  inputClass,
  LabelledField,
  SaveRow,
  useProductSave,
} from "../editor-parts";

/**
 * When the listing goes live and when it comes down.
 *
 * The dates are a record of intent, not a second publishing mechanism: the
 * status is still what decides visibility, and the scheduled job that acts on
 * these dates goes through the same publish check as a person would. A date
 * on its own can therefore never put an unfinished listing in front of a
 * shopper.
 */
export function PublishingSection({
  productId,
  status,
  publishAt,
  unpublishAt,
}: {
  productId: string;
  status: string;
  publishAt: string;
  unpublishAt: string;
}) {
  const router = useRouter();
  const { save, pending, error, message, dirty, markDirty } = useProductSave(
    productId,
    () => router.refresh(),
  );

  const [from, setFrom] = useState(publishAt);
  const [until, setUntil] = useState(unpublishAt);
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);

    if (from && until && new Date(until) <= new Date(from)) {
      setLocalError("The unpublish date has to be after the publish date.");
      return;
    }

    await save({
      publishAt: from ? new Date(from).toISOString() : null,
      unpublishAt: until ? new Date(until).toISOString() : null,
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-6" noValidate>
      <p className="max-w-[70ch] text-meta text-ink/70">
        Optional. Dates record when this listing should go up and come down;
        publishing itself still runs the readiness checks.{" "}
        <span className="sr-only">Current status: {status}.</span>
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <LabelledField
          label="Publish on"
          htmlFor="publishAt"
          hint="Leave empty to publish by hand."
        >
          <input
            id="publishAt"
            type="datetime-local"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              markDirty();
            }}
            className={inputClass}
          />
        </LabelledField>

        <LabelledField
          label="Unpublish on"
          htmlFor="unpublishAt"
          hint="For a listing that should come down on a date — a seasonal line, say."
        >
          <input
            id="unpublishAt"
            type="datetime-local"
            value={until}
            onChange={(event) => {
              setUntil(event.target.value);
              markDirty();
            }}
            className={inputClass}
          />
        </LabelledField>
      </div>

      <SaveRow
        pending={pending}
        dirty={dirty}
        error={localError ?? error}
        message={message}
        label="Save dates"
      />
    </form>
  );
}
