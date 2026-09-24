import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { SearchConsoleTab } from "../panels/search-console-tab";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Search Console · Intelligence" };

export default async function IntelligenceSearchConsolePage() {
  const user = await requireAdminPage("seo.view");
  return <SearchConsoleTab user={user} />;
}
