import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { getCampaignSettings } from "@/lib/homepage";
import { HomepageEditor } from "./homepage-editor";
import { listCategoryTreeForLinks } from "./link-options";

export const metadata: Metadata = { title: "Homepage" };
export const dynamic = "force-dynamic";

/**
 * Homepage settings: the promotional campaigns.
 *
 * Everything here writes to `site_settings` through `lib/homepage` and shows
 * on the live storefront on the next request. There is no preview-only mode
 * and no setting here that does nothing.
 */
export default async function AdminHomepagePage() {
  // The layout gated /admin; this is the page's own check, and every write
  // behind it checks `homepage.manage` again.
  await requireAdminPage("homepage.manage");

  const [settings, links] = await Promise.all([
    getCampaignSettings(),
    listCategoryTreeForLinks(),
  ]);

  const live = settings.slides.filter((slide) => slide.active && slide.image).length;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <h1 className="admin-h1">Homepage</h1>
        <p className="mt-1 max-w-[80ch] text-meta text-ink/70">
          Up to five promotional slides. Each is one hero photograph and the
          four tiles beneath it — they always change together. Only slides
          switched on with a photograph appear on the site; {live} of 5{" "}
          {live === 1 ? "is" : "are"} live now.
        </p>
      </div>

      <HomepageEditor initial={settings} linkOptions={links} />
    </div>
  );
}
