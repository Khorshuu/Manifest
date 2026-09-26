import type { PkbProposalSuggestion } from "@/db/schema";

/** The groups the review screen sorts discovered labels into (D-123). */
export type ProposalGroup = "facts" | "composition" | "use" | "safety" | "box" | "version" | "passages";

export const PROPOSAL_GROUP_LABELS: Record<ProposalGroup, string> = {
  facts: "Product facts",
  composition: "Ingredients and materials",
  use: "Use and compatibility",
  safety: "Warnings and safety",
  box: "In the box",
  version: "This version only",
  passages: "Passages of text (usually descriptions — most are ignored)",
};

/**
 * Which group a proposal belongs to on the review screen: what research
 * suggested it is, or, for a label the structured readers found, whether its
 * example is a value or a paragraph. Grouping only; nothing is decided by it.
 */
export function proposalGroup(proposal: { exampleValue: string; suggestion: PkbProposalSuggestion | null; variantDefining: boolean }): ProposalGroup {
  if (proposal.variantDefining) return "version";
  switch (proposal.suggestion?.kind) {
    case "composition":
      return "composition";
    case "compatibility_use":
      return "use";
    case "warning_safety":
      return "safety";
    case "box_content":
      return "box";
    case "variant_fact":
      return "version";
  }
  const value = proposal.exampleValue.trim();
  return value.length > 160 || value.split(/\s+/).length > 24 ? "passages" : "facts";
}
