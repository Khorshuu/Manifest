import type { PreparationStage } from "@/db/schema";

/**
 * The filter state the workspace carries in the address bar.
 *
 * Every deep link into Intelligence — from an overview card, from a bookmark,
 * from a link somebody pasted to a colleague — arrives as a query parameter,
 * and a parameter from the address bar is input like any other. These are the
 * guards that turn it into something the panels can use, and the mapping from
 * a name a person can read ("blocked") to the stages the backend actually
 * stores. They live apart from the panels so the rule a link relies on can be
 * tested without rendering a screen.
 *
 * An unrecognised value is not an error: the tab opens unfiltered, which is
 * the same thing the link without a parameter does.
 */

/** SeoPulse: preparation stages, grouped the way a manager thinks about them. */
export const SEO_PULSE_FILTERS = {
  "needs-review": ["NEEDS_REVIEW"],
  blocked: ["BLOCKED"],
  failed: ["FAILED"],
  active: [
    "IDENTIFYING",
    "FINDING_SOURCES",
    "RESEARCHING",
    "VERIFYING",
    "PREPARING_CONTENT",
    "PREPARING_SEARCH",
    "CHECKING_PAGE",
  ],
} as const satisfies Record<string, readonly PreparationStage[]>;

export type SeoPulseFilter = keyof typeof SEO_PULSE_FILTERS;

export const SEO_PULSE_FILTER_LABEL: Record<SeoPulseFilter, string> = {
  "needs-review": "Needs review",
  blocked: "Blocked",
  failed: "Failed",
  active: "In progress",
};

export function isSeoPulseFilter(value: unknown): value is SeoPulseFilter {
  return typeof value === "string" && value in SEO_PULSE_FILTERS;
}

/** The stages a person is waiting on, which is what the tab leads with. */
export const PREPARATION_WAITING = [
  "NEEDS_REVIEW",
  "BLOCKED",
  "FAILED",
] as const satisfies readonly PreparationStage[];

/** Product Knowledge: which part of the queue to show. */
export const KNOWLEDGE_FOCUS = [
  "conflicts",
  "claims",
  "proposals",
  "labels",
  "unresolved",
  "ambiguous",
] as const;
export type KnowledgeFocus = (typeof KNOWLEDGE_FOCUS)[number];

export const KNOWLEDGE_FOCUS_LABEL: Record<KnowledgeFocus, string> = {
  conflicts: "Conflicts",
  claims: "Proposed values",
  proposals: "New attributes",
  labels: "Unplaced labels",
  unresolved: "Unresolved identities",
  ambiguous: "Ambiguous identities",
};

/** The two focuses that list knowledge records rather than the queue. */
export const IDENTITY_FOCUS: readonly KnowledgeFocus[] = ["unresolved", "ambiguous"];

export function isKnowledgeFocus(value: unknown): value is KnowledgeFocus {
  return typeof value === "string" && (KNOWLEDGE_FOCUS as readonly string[]).includes(value);
}

/** SEO Health: the audit's own severities, worst first. */
export const SEO_SEVERITIES = ["required", "recommended", "optional"] as const;
export type SeoSeverity = (typeof SEO_SEVERITIES)[number];

export const SEO_SEVERITY_LABEL: Record<SeoSeverity, string> = {
  required: "Needed",
  recommended: "Worth doing",
  optional: "Optional",
};

export function isSeoSeverity(value: unknown): value is SeoSeverity {
  return typeof value === "string" && (SEO_SEVERITIES as readonly string[]).includes(value);
}

/** SearchPulse: the periods the search report supports. */
export const SEARCH_PERIODS = [7, 30, 90] as const;

/** The period a link may arrive with, clamped to one the report supports. */
export function searchPeriod(value: unknown): number {
  const requested = Number(value);
  return (SEARCH_PERIODS as readonly number[]).includes(requested) ? requested : 30;
}
