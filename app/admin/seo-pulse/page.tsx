import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { isSeoPulseFilter } from "../intelligence/filters";
import { SeoPulsePanel } from "../intelligence/panels/seo-pulse-panel";
import { MovedNotice } from "../intelligence/moved-notice";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "SeoPulse" };

/**
 * The catalogue-wide SeoPulse screen, kept at its old address.
 *
 * SeoPulse now lives in the Intelligence workspace, and the main navigation
 * points there. This route still answers because bookmarks, links inside
 * older reports and existing tests use it — and it answers with exactly the
 * same component the tab renders, so there is one implementation rather than
 * two that drift (task section 26).
 */
export default async function SeoPulseAdminPage({
  searchParams,
}: PageProps<"/admin/seo-pulse">) {
  const user = await requireAdminPage("catalog.manage");
  const params = await searchParams;
  const filter = isSeoPulseFilter(params.filter) ? params.filter : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <MovedNotice href="/admin/intelligence/seo-pulse" tab="SeoPulse" />
      <SeoPulsePanel user={user} filter={filter} />
    </div>
  );
}
