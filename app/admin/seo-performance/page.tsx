import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { SearchConsoleTab } from "../intelligence/panels/search-console-tab";
import { MovedNotice } from "../intelligence/moved-notice";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Search Console" };

/**
 * Search performance, kept at its old address. The Intelligence workspace
 * renders the same component as its Search Console tab (task section 26).
 *
 * Reading needs `seo.view`; acting needs `catalog.manage`, which the component
 * and the API routes behind it both check (D-101).
 */
export default async function SeoPerformancePage() {
  const user = await requireAdminPage("seo.view");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <MovedNotice href="/admin/intelligence/search-console" tab="Search Console" />
      <SearchConsoleTab user={user} />
    </div>
  );
}
