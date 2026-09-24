import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { isSeoPulseFilter } from "../filters";
import { SeoPulsePanel } from "../panels/seo-pulse-panel";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "SeoPulse · Intelligence" };

export default async function IntelligenceSeoPulsePage({
  searchParams,
}: PageProps<"/admin/intelligence/seo-pulse">) {
  const user = await requireAdminPage("catalog.manage");
  const params = await searchParams;
  const filter = isSeoPulseFilter(params.filter) ? params.filter : undefined;
  return <SeoPulsePanel user={user} filter={filter} />;
}
