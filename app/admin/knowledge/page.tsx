import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { isKnowledgeFocus } from "../intelligence/filters";
import { KnowledgePanel } from "../intelligence/panels/knowledge-panel";
import { SourcesPanel } from "../intelligence/panels/sources-panel";
import { MovedNotice } from "../intelligence/moved-notice";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Product Knowledge" };

/**
 * The knowledge screen, kept at its old address.
 *
 * In the Intelligence workspace this screen is two tabs — Product Knowledge
 * for what is waiting for a person, and Sources & Policies for the trust rules
 * that decide what counts as evidence. This route renders both of those
 * components, so a bookmark still reaches everything it used to and there is
 * still only one implementation of each half (task section 26).
 *
 * Reading is open to anyone who manages the catalogue. Approving a mapping, a
 * source or a policy needs `knowledge.manage`, and the API checks it again.
 */
export default async function AdminKnowledgePage({
  searchParams,
}: PageProps<"/admin/knowledge">) {
  const user = await requireAdminPage("catalog.manage");
  const params = await searchParams;
  const focus = isKnowledgeFocus(params.focus) ? params.focus : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <MovedNotice href="/admin/intelligence/knowledge" tab="Product Knowledge" />
      <KnowledgePanel user={user} focus={focus} />
      <SourcesPanel user={user} />
    </div>
  );
}
