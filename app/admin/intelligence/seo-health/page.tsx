import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { isSeoSeverity } from "../filters";
import { SeoHealthPanel } from "../panels/seo-health-panel";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "SEO Health · Intelligence" };

export default async function IntelligenceSeoHealthPage({
  searchParams,
}: PageProps<"/admin/intelligence/seo-health">) {
  const user = await requireAdminPage("catalog.manage");
  const params = await searchParams;
  return (
    <SeoHealthPanel
      user={user}
      basePath="/admin/intelligence/seo-health"
      severity={isSeoSeverity(params.severity) ? params.severity : undefined}
    />
  );
}
