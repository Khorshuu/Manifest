import type { PkbOrigin, PkbUsageRights, PkbVerificationState } from "@/db/schema";

/**
 * The future API boundary (D-068): which stored knowledge may leave Manifest.
 *
 * No API exists. This rule exists now so that every value is stored with what
 * the rule needs — origin, usage rights, state — and so the answer to "may
 * this be exported?" is one tested function rather than a judgement made later
 * from memory.
 */

export type ExportDecision = { eligible: boolean; reasons: string[] };

export function exportEligibility(value: {
  origin: PkbOrigin;
  usageRights: PkbUsageRights;
  verificationState: PkbVerificationState;
}): ExportDecision {
  const reasons: string[] = [];

  if (value.origin === "PROVIDER_RESTRICTED") reasons.push("Provider data is licensed for internal use only.");
  if (value.origin === "CUSTOMER_DERIVED") reasons.push("Customer-derived signals leave Manifest only as aggregates.");
  if (value.origin === "UNKNOWN_LEGACY") reasons.push("The origin, and so the right to share it, is unknown.");
  if (value.usageRights !== "exportable") {
    reasons.push(
      value.usageRights === "unknown"
        ? "Nobody has confirmed the source may be republished."
        : `The source allows ${value.usageRights.replace("_", " ")} use only.`,
    );
  }
  if (value.verificationState !== "VERIFIED" && value.verificationState !== "MANUAL") {
    reasons.push("Only verified or staff-entered values are offered to others.");
  }

  return { eligible: reasons.length === 0, reasons };
}
