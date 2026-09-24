import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { searchPeriod } from "../filters";
import { SearchPulsePanel } from "../panels/searchpulse-panel";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "SearchPulse · Intelligence" };

export default async function IntelligenceSearchPulsePage({
  searchParams,
}: PageProps<"/admin/intelligence/searchpulse">) {
  const user = await requireAdminPage("search.manage");
  const params = await searchParams;
  return (
    <SearchPulsePanel
      user={user}
      basePath="/admin/intelligence/searchpulse"
      days={searchPeriod(params.days)}
      prefillTerm={typeof params.term === "string" ? params.term.slice(0, 60) : ""}
    />
  );
}
