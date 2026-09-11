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
import { LogoutButton } from "./logout-button";

/**
 * Each section with the permission that opens it. The page checks the same
 * permission itself, and so does every `lib/` function behind it — this list
 * only decides what the navigation offers (CLAUDE.md §7).
 */
const navigation: { href: string; label: string; permission: Permission | null }[] = [
  { href: "/admin", label: "Overview", permission: null },
  { href: "/admin/orders", label: "Orders", permission: "orders.view" },
  { href: "/admin/products", label: "Products", permission: "catalog.manage" },
  { href: "/admin/categories", label: "Categories", permission: "catalog.manage" },
  { href: "/admin/customers", label: "Customers", permission: "customers.view" },
  { href: "/admin/homepage", label: "Homepage", permission: "homepage.manage" },
  { href: "/admin/reviews", label: "Reviews", permission: "reviews.moderate" },
  { href: "/admin/search", label: "Search", permission: "search.manage" },
  { href: "/admin/seo-pulse", label: "SEO Pulse", permission: "catalog.manage" },
  { href: "/admin/notifications", label: "Notifications", permission: "notifications.view" },
  { href: "/admin/analytics", label: "Analytics", permission: "analytics.view" },
  { href: "/admin/audit", label: "Audit log", permission: "audit.view" },
  { href: "/admin/staff", label: "Staff", permission: "staff.manage" },
  { href: "/admin/settings", label: "Settings", permission: "settings.manage" },
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
    .filter((item) => item.permission === null || can(user, item.permission))
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
