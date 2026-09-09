import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { requireStaff } from "@/lib/auth/authorize";
import { listProductCards } from "@/lib/catalog";
import { getHeroSettings } from "@/lib/homepage";
import { HeroEditor } from "./hero-editor";

export const metadata: Metadata = { title: "Homepage" };
export const dynamic = "force-dynamic";

/**
 * The homepage hero, edited by staff.
 *
 * Everything on this page writes to `site_settings` through
 * `lib/homepage/hero.ts` and shows on the live storefront on the next request.
 * There is no preview-only mode and no setting here that does nothing.
 */
export default async function AdminHomepagePage() {
  const user = await getCurrentUser();
  // The layout already gated /admin; this is the second, real check — the one
  // that would still refuse if the layout were bypassed.
  requireStaff(user);

  const [hero, products] = await Promise.all([
    getHeroSettings(),
    // What staff may feature: public listings only, newest first. A hero
    // cannot be pointed at a draft, because a draft is not offered here.
    listProductCards({ sort: "newest", limit: 60 }),
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <p className="flex items-center gap-3 text-meta font-semibold uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Storefront
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Homepage hero</h1>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          The photograph, the words and the batch on the first screen of the
          shop. Changes are live as soon as they save, and every one is written
          to the audit log with the value it replaced.
        </p>
      </div>

      <HeroEditor
        hero={hero}
        products={products.map((product) => ({
          slug: product.slug,
          title: product.title,
          brand: product.brand,
        }))}
      />
    </div>
  );
}
