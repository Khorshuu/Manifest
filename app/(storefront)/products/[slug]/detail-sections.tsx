import { IconAlert, IconCheck, IconSeal, IconShield } from "@/components/icons";

/**
 * The sections below the buy box.
 *
 * Every one of them returns null when it has nothing to say. That is the
 * rule the whole lower half of this page is built on: an empty "Warranty"
 * heading reads as a promise the shop forgot to fill in, and a specification
 * table full of dashes reads as a listing nobody finished.
 */

export type SpecRow = { label: string; value: string };

export function Section({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="min-w-0">
      <h2 className="font-display text-h2 text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The manifest table, shared with the admin side.
 *
 * Rows are deduplicated by label, first one winning.
 *
 * The table draws on four sources — the listing's own facts, the category's
 * specifications, the advanced block and rows typed by hand — and the same
 * fact can honestly appear in two of them. Printing "Impedance" twice makes
 * the listing look unmaintained, and the earlier source is the more
 * structured one.
 */
export function SpecTable({ rows }: { rows: SpecRow[] }) {
  const seen = new Set<string>();
  rows = rows.filter((row) => {
    const key = row.label.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-card border border-ink/15 shadow-[var(--shadow-raise)]">
      <table className="w-full border-collapse text-body">
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.label}-${index}`}
              className={index % 2 === 1 ? "bg-blue-200/40" : undefined}
            >
              <th
                scope="row"
                className="border-b border-blue-300 px-4 py-3 text-left align-top text-meta font-medium text-ink/70 last:border-b-0"
              >
                {row.label}
              </th>
              <td className="border-b border-blue-300 px-4 py-3 align-top text-ink last:border-b-0">
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Highlights({ items }: { items: string[] }) {
  if (items.length === 0) return null;

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-3 text-body text-ink/80">
          <IconCheck
            size={18}
            className="mt-1 shrink-0 text-transit-green-text"
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

export function BoxContents({ items }: { items: string[] }) {
  if (items.length === 0) return null;

  return (
    <Section title="What's in the box">
      <ul className="flex flex-col gap-2 rounded-card border border-blue-300 bg-paper p-4 shadow-[var(--shadow-raise)]">
        {items.map((item) => (
          <li
            key={item}
            className="flex items-start gap-3 border-b border-blue-300 pb-2 text-body text-ink/80 last:border-b-0 last:pb-0"
          >
            <IconSeal size={16} className="mt-1 shrink-0 text-brass-text" />
            {item}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export type WarrantyView = {
  hasWarranty: boolean;
  durationMonths?: number | null;
  type?: string | null;
  provider?: string | null;
  description?: string | null;
  terms?: string | null;
};

function months(count: number): string {
  if (count % 12 === 0) {
    const years = count / 12;
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return `${count} month${count === 1 ? "" : "s"}`;
}

export function Warranty({ warranty }: { warranty: WarrantyView | null }) {
  if (!warranty?.hasWarranty) return null;

  const rows: SpecRow[] = [
    warranty.durationMonths
      ? { label: "Length", value: months(warranty.durationMonths) }
      : null,
    warranty.type ? { label: "Type", value: warranty.type } : null,
    warranty.provider ? { label: "Provided by", value: warranty.provider } : null,
  ].filter((row): row is SpecRow => row !== null);

  return (
    <Section title="Warranty">
      <div className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-body text-transit-green-text">
          <IconShield size={18} className="shrink-0" />
          This product is covered by a warranty
          {warranty.durationMonths
            ? ` for ${months(warranty.durationMonths)}`
            : ""}
          .
        </p>
        {warranty.description ? (
          <p className="max-w-[62ch] text-body text-ink/80">
            {warranty.description}
          </p>
        ) : null}
        <SpecTable rows={rows} />
        {warranty.terms ? (
          <details className="rounded-card border border-blue-300 bg-paper p-4">
            <summary className="min-h-11 cursor-pointer text-body text-blue-600">
              Warranty terms
            </summary>
            <p className="mt-3 max-w-[62ch] whitespace-pre-line text-meta text-ink/80">
              {warranty.terms}
            </p>
          </details>
        ) : null}
      </div>
    </Section>
  );
}

export type ComplianceView = {
  certifications?: { name: string; number?: string | null }[];
  compliance?: string | null;
  safety?: string | null;
  warnings?: string | null;
  countryOfOrigin?: string | null;
  regulatory?: string | null;
};

export function Compliance({ compliance }: { compliance: ComplianceView | null }) {
  if (!compliance) return null;

  const certifications = compliance.certifications ?? [];
  const paragraphs = [
    { label: "Compliance", value: compliance.compliance },
    { label: "Safety", value: compliance.safety },
    { label: "Regulatory", value: compliance.regulatory },
  ].filter((entry) => Boolean(entry.value));

  if (
    certifications.length === 0 &&
    paragraphs.length === 0 &&
    !compliance.warnings
  ) {
    return null;
  }

  return (
    <Section title="Certifications and safety">
      <div className="flex flex-col gap-4">
        {certifications.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {certifications.map((entry) => (
              <li
                key={entry.name}
                className="rounded-control border border-blue-300 px-3 py-1 text-meta text-ink"
              >
                {entry.name}
                {entry.number ? (
                  <span className="text-ink/70"> · {entry.number}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {paragraphs.map((entry) => (
          <div key={entry.label}>
            <h3 className="text-meta font-medium text-ink">{entry.label}</h3>
            <p className="mt-1 max-w-[62ch] whitespace-pre-line text-body text-ink/80">
              {entry.value}
            </p>
          </div>
        ))}

        {compliance.warnings ? (
          <p className="flex max-w-[62ch] items-start gap-2 rounded-card border border-stamp-red bg-stamp-red/5 p-3 text-meta text-stamp-red-text">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            <span className="whitespace-pre-line">{compliance.warnings}</span>
          </p>
        ) : null}
      </div>
    </Section>
  );
}

export function LifestyleBand({
  images,
  title,
}: {
  images: { id: string; url: string; altText: string }[];
  title: string;
}) {
  if (images.length === 0) return null;

  return (
    <Section title={`${title} in use`}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {images.map((image) => (
          <li
            key={image.id}
            className="overflow-hidden rounded-card border border-blue-300 shadow-[var(--shadow-raise)]"
          >
            {/* Below the fold by construction, so every one of these is lazy —
                the buy box must not wait on them. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.url}
              alt={image.altText}
              loading="lazy"
              decoding="async"
              className="aspect-[4/3] w-full object-cover transition-transform duration-500 ease-out hover:scale-[1.03] motion-reduce:transition-none"
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}
