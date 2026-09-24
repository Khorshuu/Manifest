import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { isKnowledgeFocus } from "../filters";
import { KnowledgePanel } from "../panels/knowledge-panel";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Product Knowledge · Intelligence" };

export default async function IntelligenceKnowledgePage({
  searchParams,
}: PageProps<"/admin/intelligence/knowledge">) {
  const user = await requireAdminPage("catalog.manage");
  const params = await searchParams;
  const focus = isKnowledgeFocus(params.focus) ? params.focus : undefined;
  return <KnowledgePanel user={user} focus={focus} />;
}
