import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { searchPeriod } from "../intelligence/filters";
import { SearchPulsePanel } from "../intelligence/panels/searchpulse-panel";
import { MovedNotice } from "../intelligence/moved-notice";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "SearchPulse" };

/**
 * The search screen, kept at its old address.
 *
 * SearchPulse is now a tab of the Intelligence workspace; this route renders
 * the same component, with its own address in the period links so a bookmark
 * with `?days=90` on it still works and still stays here (task section 26).
 */
export default async function AdminSearchPage({
  searchParams,
}: PageProps<"/admin/search">) {
  const user = await requireAdminPage("search.manage");
  const params = await searchParams;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <MovedNotice href="/admin/intelligence/searchpulse" tab="SearchPulse" />
      <SearchPulsePanel
        user={user}
        basePath="/admin/search"
        days={searchPeriod(params.days)}
        prefillTerm={typeof params.term === "string" ? params.term.slice(0, 60) : ""}
      />
    </div>
  );
}
