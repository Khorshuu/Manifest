import Link from "next/link";
import type { ListingAudit } from "@/lib/seo/audit";

/**
 * What is wrong with this page as search sees it (D-087).
 *
 * The readiness panel above says what this listing's own fields are missing.
 * This says the rest: whether the page can be indexed at all, what is wrong
 * with its photography, and what it is saying that another page of this shop
 * already says. Nothing here is a score, and nothing here fixes itself.
 */
export function PageAuditBox({ audit }: { audit: ListingAudit }) {
  const technical = audit.technical;
  const nothingWrong = audit.findings.length === 0 && audit.duplication.length === 0;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">Page audit</h2>
        {technical ? (
          <p className="text-[0.75rem] text-ink/65">
            {technical.indexable ? "Indexable" : "Not indexed"} — {technical.indexableReason}. Canonical{" "}
            <span className="font-mono">{technical.canonicalTarget}</span>.
          </p>
        ) : null}
      </div>

      {nothingWrong ? (
        <p className="text-[0.75rem] text-ink/65">
          Nothing to fix: the page can be crawled, its photographs are described, and no other listing says the same
          thing.
        </p>
      ) : null}

      {audit.findings.length > 0 ? (
        <ul className="flex flex-col gap-2 border-t border-line pt-2">
          {audit.findings.map((finding) => (
            <li key={finding.id} className="flex flex-col gap-0.5">
              <p className="text-[0.8rem] font-medium text-ink">
                {finding.label}{" "}
                <span className="text-[0.7rem] font-normal uppercase tracking-wide text-ink/50">
                  {finding.severity === "required" ? "Needed" : finding.severity === "recommended" ? "Worth doing" : "Optional"}
                </span>
              </p>
              <p className="text-[0.75rem] text-ink/65">{finding.detail}</p>
              <p className="text-[0.75rem] text-ink/55">{finding.fix}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {audit.duplication.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-line pt-2">
          <p className="text-[0.8rem] font-medium text-ink">Words shared with another listing</p>
          {audit.duplication.map((group) => (
            <div key={group.field} className="flex flex-col gap-0.5">
              <p className="text-[0.75rem] text-ink/65">
                {group.label}: “{group.shared}”
              </p>
              <ul className="flex flex-wrap gap-x-3 text-[0.75rem]">
                {group.with.map((other) => (
                  <li key={other.id}>
                    <Link className="text-blue-600 hover:underline" href={`/admin/products/${other.id}`}>
                      {other.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-[0.75rem] text-ink/55">
            Two pages competing on the same words make each other harder to find. Give this one the words that separate
            it.
          </p>
        </div>
      ) : null}
    </section>
  );
}
