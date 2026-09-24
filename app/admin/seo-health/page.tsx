import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { isSeoSeverity } from "../intelligence/filters";
import { SeoHealthPanel } from "../intelligence/panels/seo-health-panel";
import { MovedNotice } from "../intelligence/moved-notice";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "SEO Health" };

/**
 * SEO health across the catalogue, kept at its old address. The Intelligence
 * workspace renders the same component as its SEO Health tab (task section 26).
 */
export default async function SeoHealthPage({
  searchParams,
}: PageProps<"/admin/seo-health">) {
  const user = await requireAdminPage("catalog.manage");
  const params = await searchParams;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <MovedNotice href="/admin/intelligence/seo-health" tab="SEO Health" />
      <SeoHealthPanel
        user={user}
        basePath="/admin/seo-health"
        severity={isSeoSeverity(params.severity) ? params.severity : undefined}
      />
    </div>
  );
}
