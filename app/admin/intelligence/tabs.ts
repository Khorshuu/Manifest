import type { Permission } from "@/lib/auth/authorize";

/**
 * The Intelligence workspace, as one list.
 *
 * Manifest grew five separate top-level admin destinations over the systems
 * that answer the same question — what does this catalogue need me to do
 * about how it is found? — and five entries in a sixteen-item navigation is
 * how a platform starts to feel like a pile of screens. This list is the
 * single place that says what the workspace contains, which permission opens
 * each part, and what each part is called.
 *
 * Nothing here is access control. Every tab's page asks for the same
 * permission again with `requireAdminPage`, and every function it calls in
 * `lib/` asks a third time (CLAUDE.md section 7). This decides what to offer.
 */
export type IntelligenceTab = {
  /** The route. Nested rather than a query parameter, so each tab is a page. */
  href:
    | "/admin/intelligence"
    | "/admin/intelligence/seo-pulse"
    | "/admin/intelligence/knowledge"
    | "/admin/intelligence/searchpulse"
    | "/admin/intelligence/seo-health"
    | "/admin/intelligence/search-console"
    | "/admin/intelligence/sources";
  label: string;
  /** One line, for the tab's own page heading. */
  summary: string;
  /**
   * Any one of these opens the tab. A tab nobody in the role can open is not
   * shown at all rather than shown and refused (task section 14).
   */
  permissions: readonly Permission[];
};

export const INTELLIGENCE_TABS: readonly IntelligenceTab[] = [
  {
    href: "/admin/intelligence",
    label: "Overview",
    summary: "What needs your attention across product research, knowledge, search and SEO.",
    permissions: ["catalog.manage", "search.manage", "seo.view"],
  },
  {
    href: "/admin/intelligence/seo-pulse",
    label: "SeoPulse",
    summary: "Product research and preparation: what has run, what stopped, and what has never been researched.",
    permissions: ["catalog.manage"],
  },
  {
    href: "/admin/intelligence/knowledge",
    label: "Product Knowledge",
    summary: "Facts about products, where each came from, and what is waiting for a decision.",
    permissions: ["catalog.manage"],
  },
  {
    href: "/admin/intelligence/searchpulse",
    label: "SearchPulse",
    summary: "What shoppers search for on this site, what they fail to find, and the index behind it.",
    permissions: ["search.manage"],
  },
  {
    href: "/admin/intelligence/seo-health",
    label: "SEO Health",
    summary: "What is measurably missing across the catalogue, counted from published listings.",
    permissions: ["catalog.manage"],
  },
  {
    href: "/admin/intelligence/search-console",
    label: "Search Console",
    summary: "What Google reports about these pages, and what the measurements say is worth doing.",
    permissions: ["seo.view"],
  },
  {
    href: "/admin/intelligence/sources",
    label: "Sources & Policies",
    summary: "Which domains speak for a brand, what counts as evidence, and how supplied labels are placed.",
    permissions: ["catalog.manage"],
  },
] as const;

/** The permissions that open at least one tab — the gate on the workspace. */
export const INTELLIGENCE_PERMISSIONS = [
  "catalog.manage",
  "search.manage",
  "seo.view",
] as const satisfies readonly Permission[];
