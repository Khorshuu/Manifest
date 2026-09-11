"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { IconMinus, IconPlus } from "@/components/icons";
import {
  areaClass,
  inputClass,
  LabelledField,
  orNull,
  SaveRow,
  useProductSave,
} from "../editor-parts";

/**
 * Warranty, certifications and safety.
 *
 * All of it optional, and the product page renders nothing for a product that
 * has none — an empty "Warranty" heading is worse than no heading, because it
 * reads as a promise the shop failed to fill in.
 */

export type AssuranceSectionValues = {
  id: string;
  warranty: {
    hasWarranty: boolean;
    durationMonths: number | null;
    type: string | null;
    provider: string | null;
    description: string | null;
    terms: string | null;
  } | null;
  compliance: {
    certifications: { name: string; number: string | null }[];
    compliance: string | null;
    safety: string | null;
    warnings: string | null;
    countryOfOrigin: string | null;
    regulatory: string | null;
  } | null;
};

export function AssuranceSection({
  product,
}: {
  product: AssuranceSectionValues;
}) {
  const router = useRouter();
  const { save, pending, error, message, dirty, markDirty } = useProductSave(
    product.id,
    () => router.refresh(),
  );

  const [hasWarranty, setHasWarranty] = useState(
    product.warranty?.hasWarranty ?? false,
  );
  const [months, setMonths] = useState(
    product.warranty?.durationMonths?.toString() ?? "",
  );
  const [type, setType] = useState(product.warranty?.type ?? "");
  const [provider, setProvider] = useState(product.warranty?.provider ?? "");
  const [warrantyText, setWarrantyText] = useState(
    product.warranty?.description ?? "",
  );
  const [terms, setTerms] = useState(product.warranty?.terms ?? "");

  const [certifications, setCertifications] = useState(
    product.compliance?.certifications ?? [],
  );
  const [compliance, setCompliance] = useState(
    product.compliance?.compliance ?? "",
  );
  const [safety, setSafety] = useState(product.compliance?.safety ?? "");
  const [warnings, setWarnings] = useState(product.compliance?.warnings ?? "");
  const [origin, setOrigin] = useState(
    product.compliance?.countryOfOrigin ?? "",
  );
  const [regulatory, setRegulatory] = useState(
    product.compliance?.regulatory ?? "",
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const keptCertifications = certifications
      .map((entry) => ({
        name: entry.name.trim(),
        number: orNull(entry.number ?? ""),
      }))
      .filter((entry) => entry.name.length > 0);

    const complianceBlock = {
      certifications: keptCertifications,
      compliance: orNull(compliance),
      safety: orNull(safety),
      warnings: orNull(warnings),
      countryOfOrigin: orNull(origin),
      regulatory: orNull(regulatory),
    };

    // Nothing filled in is stored as null rather than as an object of nulls,
    // so "does this product have compliance information" stays one check.
    const anyCompliance =
      keptCertifications.length > 0 ||
      [compliance, safety, warnings, origin, regulatory].some(
        (value) => value.trim().length > 0,
      );

    await save({
      warranty: hasWarranty
        ? {
            hasWarranty: true,
            durationMonths: months.trim() ? Number(months) : null,
            type: orNull(type),
            provider: orNull(provider),
            description: orNull(warrantyText),
            terms: orNull(terms),
          }
        : null,
      compliance: anyCompliance ? complianceBlock : null,
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-8" noValidate>
      <section className="flex flex-col gap-4">
        <h3 className="font-display text-h3 text-ink">Warranty</h3>

        <label className="flex min-h-11 items-center gap-3 text-body text-ink">
          <input
            type="checkbox"
            checked={hasWarranty}
            onChange={(event) => {
              setHasWarranty(event.target.checked);
              markDirty();
            }}
            className="size-4"
          />
          This product comes with a warranty
        </label>

        {hasWarranty ? (
          <div className="flex flex-col gap-4 border-l-2 border-blue-300 pl-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <LabelledField label="Duration in months" htmlFor="warrantyMonths">
                <input
                  id="warrantyMonths"
                  type="number"
                  min={0}
                  value={months}
                  onChange={(event) => {
                    setMonths(event.target.value);
                    markDirty();
                  }}
                  className={inputClass}
                />
              </LabelledField>

              <LabelledField
                label="Type"
                htmlFor="warrantyType"
                hint="Manufacturer, seller, extended."
              >
                <input
                  id="warrantyType"
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value);
                    markDirty();
                  }}
                  className={inputClass}
                />
              </LabelledField>
            </div>

            <LabelledField label="Provider" htmlFor="warrantyProvider">
              <input
                id="warrantyProvider"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value);
                  markDirty();
                }}
                className={inputClass}
              />
            </LabelledField>

            <LabelledField label="What it covers" htmlFor="warrantyDescription">
              <textarea
                id="warrantyDescription"
                rows={3}
                value={warrantyText}
                onChange={(event) => {
                  setWarrantyText(event.target.value);
                  markDirty();
                }}
                className={areaClass}
              />
            </LabelledField>

            <LabelledField label="Terms" htmlFor="warrantyTerms">
              <textarea
                id="warrantyTerms"
                rows={4}
                value={terms}
                onChange={(event) => {
                  setTerms(event.target.value);
                  markDirty();
                }}
                className={areaClass}
              />
            </LabelledField>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-4 border-t border-blue-300 pt-6">
        <div>
          <h3 className="font-display text-h3 text-ink">
            Certifications and safety
          </h3>
          <p className="mt-1 max-w-[70ch] text-meta text-ink/70">
            Optional, and category-dependent. The product page shows only the
            parts that are filled in.
          </p>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-meta font-medium text-ink">
            Certifications
          </legend>

          <ul className="flex flex-col gap-2">
            {certifications.map((entry, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2">
                <input
                  value={entry.name}
                  placeholder="CE"
                  aria-label={`Certification ${index + 1} name`}
                  onChange={(event) => {
                    const next = [...certifications];
                    next[index] = { ...next[index], name: event.target.value };
                    setCertifications(next);
                    markDirty();
                  }}
                  className={`${inputClass} min-w-0 flex-1`}
                />
                <input
                  value={entry.number ?? ""}
                  placeholder="Certificate number (optional)"
                  aria-label={`Certification ${index + 1} number`}
                  onChange={(event) => {
                    const next = [...certifications];
                    next[index] = { ...next[index], number: event.target.value };
                    setCertifications(next);
                    markDirty();
                  }}
                  className={`${inputClass} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  onClick={() => {
                    setCertifications(
                      certifications.filter((_, i) => i !== index),
                    );
                    markDirty();
                  }}
                  className="inline-flex size-11 items-center justify-center rounded-control border border-blue-300 text-stamp-red-text"
                >
                  <IconMinus size={16} />
                  <span className="sr-only">
                    Remove certification {index + 1}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setCertifications([...certifications, { name: "", number: "" }]);
                markDirty();
              }}
            >
              <IconPlus size={15} />
              Add a certification
            </Button>
          </div>
        </fieldset>

        <LabelledField label="Country of origin" htmlFor="countryOfOrigin">
          <input
            id="countryOfOrigin"
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value);
              markDirty();
            }}
            className={inputClass}
          />
        </LabelledField>

        <LabelledField label="Compliance information" htmlFor="complianceText">
          <textarea
            id="complianceText"
            rows={3}
            value={compliance}
            onChange={(event) => {
              setCompliance(event.target.value);
              markDirty();
            }}
            className={areaClass}
          />
        </LabelledField>

        <LabelledField label="Safety information" htmlFor="safetyText">
          <textarea
            id="safetyText"
            rows={3}
            value={safety}
            onChange={(event) => {
              setSafety(event.target.value);
              markDirty();
            }}
            className={areaClass}
          />
        </LabelledField>

        <LabelledField
          label="Safety warnings"
          htmlFor="warningsText"
          hint="Shown with a warning mark, apart from the rest."
        >
          <textarea
            id="warningsText"
            rows={3}
            value={warnings}
            onChange={(event) => {
              setWarnings(event.target.value);
              markDirty();
            }}
            className={areaClass}
          />
        </LabelledField>

        <LabelledField label="Other regulatory information" htmlFor="regulatoryText">
          <textarea
            id="regulatoryText"
            rows={3}
            value={regulatory}
            onChange={(event) => {
              setRegulatory(event.target.value);
              markDirty();
            }}
            className={areaClass}
          />
        </LabelledField>
      </section>

      <SaveRow pending={pending} dirty={dirty} error={error} message={message} />
    </form>
  );
}
