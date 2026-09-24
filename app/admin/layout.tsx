import { redirect } from "next/navigation";
import {
  can,
  getCurrentUser,
  isStaff,
  isStaffRole,
  ROLE_DETAILS,
  type Permission,
} from "@/lib/auth";
import { AdminNav } from "./admin-nav";
import { INTELLIGENCE_PERMISSIONS } from "./intelligence/tabs";
import { LogoutButton } from "./logout-button";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

/**
 * Each section with the permissions that open it — any one of them is enough,
 * and an empty list means every staff role. The page checks the same
 * permission itself, and so does every `lib/` function behind it — this list
 * only decides what the navigation offers (CLAUDE.md §7).
 */
const navigation: { href: string; label: string; permissions: readonly Permission[] }[] = [
  { href: "/admin", label: "Overview", permissions: [] },
  { href: "/admin/orders", label: "Orders", permissions: ["orders.view"] },
  { href: "/admin/products", label: "Products", permissions: ["catalog.manage"] },
  { href: "/admin/categories", label: "Categories", permissions: ["catalog.manage"] },
  { href: "/admin/customers", label: "Customers", permissions: ["customers.view"] },
  { href: "/admin/homepage", label: "Homepage", permissions: ["homepage.manage"] },
  { href: "/admin/reviews", label: "Reviews", permissions: ["reviews.moderate"] },
  /*
   * One entry for the whole of Intelligence.
   *
   * Search, SEO Pulse, SEO health, Search performance and Knowledge were five
   * separate top-level destinations over systems that answer the same
   * question, which is five of the sixteen links here. They are now the tabs
   * of /admin/intelligence; their own routes still work for bookmarks and
   * deep links, they are simply no longer offered separately. Any one of these
   * permissions opens at least one tab, and each tab checks its own.
   */
  {
    href: "/admin/intelligence",
    label: "Intelligence",
    permissions: INTELLIGENCE_PERMISSIONS,
  },
  { href: "/admin/notifications", label: "Notifications", permissions: ["notifications.view"] },
  { href: "/admin/jobs", label: "Background work", permissions: ["notifications.view"] },
  { href: "/admin/analytics", label: "Analytics", permissions: ["analytics.view"] },
  { href: "/admin/audit", label: "Audit log", permissions: ["audit.view"] },
  { href: "/admin/staff", label: "Staff", permissions: ["staff.manage"] },
  { href: "/admin/settings", label: "Settings", permissions: ["settings.manage"] },
];

/**
 * Gate for everything under /admin. This is a real check, not a hidden link:
 * every mutation under here re-checks the permission in lib/ as well, so a
 * route that forgets this layout still cannot be used by a customer.
 */
export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const user = await getCurrentUser();

  if (!user) redirect("/login?next=/admin");
  if (!isStaff(user)) redirect("/");

  const visible = navigation
    .filter(
      (item) =>
        item.permissions.length === 0 ||
        item.permissions.some((permission) => can(user, permission)),
    )
    .map(({ href, label }) => ({ href, label }));

  const roleLabel = isStaffRole(user.role) ? ROLE_DETAILS[user.role].label : "Staff";

  return (
    <div className="admin-ui flex min-h-full flex-col bg-paper-raised">
      <AdminNav
        items={visible}
        identity={`${user.email} · ${roleLabel}`}
        signOut={<LogoutButton />}
      />

      <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 md:px-6 md:py-8">
        {children}
      </main>
    </div>
  );
}
