import { redirect } from "next/navigation";
import { can } from "@/lib/auth/authorize";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { INTELLIGENCE_TABS } from "./tabs";
import { WorkspaceTabs } from "./workspace-tabs";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

/**
 * The Intelligence workspace: one destination over the systems that decide
 * how this catalogue is understood and found.
 *
 * The systems underneath are unchanged and still separate — SeoPulse, the
 * Product Knowledge Base, SearchPulse, the SEO audit and Search Console each
 * own their own data, their own permissions and their own APIs. What changed
 * is that a person no longer has to know which of five screens holds the
 * thing they are looking for.
 *
 * A tab is only offered to a role that can open it, and every tab's page
 * checks the same permission itself. Somebody who holds none of them never
 * reaches this layout: the navigation does not offer Intelligence, and the
 * redirect below turns away anyone who types the address.
 */
export default async function IntelligenceLayout({
  children,
}: LayoutProps<"/admin/intelligence">) {
  const user = await requireAdminPage();

  const tabs = INTELLIGENCE_TABS.filter((tab) =>
    tab.permissions.some((permission) => can(user, permission)),
  );
  if (tabs.length === 0) redirect("/admin?denied=1");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-1">
        <p className="text-[0.7rem] uppercase tracking-[0.18em] text-ink/55">Manifest</p>
        <h1 className="admin-h1">Intelligence</h1>
        <p className="max-w-[72ch] text-[0.8125rem] text-ink/65">
          Product research, product knowledge, site search and how these pages perform in Google —
          in one place, with the work that needs a person first.
        </p>
      </header>

      <WorkspaceTabs tabs={tabs} />

      <div className="min-w-0">{children}</div>
    </div>
  );
}
