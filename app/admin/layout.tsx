import { redirect } from "next/navigation";
import { getCurrentUser, isStaff, isSuperAdmin } from "@/lib/auth";
import { AdminNav } from "./admin-nav";
import { LogoutButton } from "./logout-button";

const navigation = [
  { href: "/admin", label: "Overview", superAdminOnly: false },
  { href: "/admin/products", label: "Products", superAdminOnly: false },
  { href: "/admin/categories", label: "Categories", superAdminOnly: false },
  { href: "/admin/orders", label: "Orders", superAdminOnly: false },
  { href: "/admin/reviews", label: "Reviews", superAdminOnly: false },
  { href: "/admin/notifications", label: "Notifications", superAdminOnly: false },
  { href: "/admin/analytics", label: "Analytics", superAdminOnly: false },
  { href: "/admin/audit", label: "Audit log", superAdminOnly: false },
  { href: "/admin/staff", label: "Staff", superAdminOnly: true },
  { href: "/admin/settings", label: "Settings", superAdminOnly: true },
] as const;

/**
 * Gate for everything under /admin. This is a real check, not a hidden link:
 * every mutation under here re-checks the role in lib/ as well, so a route
 * that forgets this layout still cannot be used by a customer.
 */
export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const user = await getCurrentUser();

  if (!user) redirect("/login?next=/admin");
  if (!isStaff(user)) redirect("/");

  const visible = navigation
    .filter((item) => !item.superAdminOnly || isSuperAdmin(user))
    .map(({ href, label }) => ({ href, label }));

  return (
    <div className="flex min-h-full flex-col">
      <AdminNav
        items={visible}
        identity={`${user.email} · ${
          user.role === "super_admin" ? "Super admin" : "Staff"
        }`}
        signOut={<LogoutButton />}
      />

      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 md:px-6 md:py-10">
        {children}
      </main>
    </div>
  );
}
