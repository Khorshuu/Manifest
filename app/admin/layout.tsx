import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, isStaff, isSuperAdmin } from "@/lib/auth";
import { LogoutButton } from "./logout-button";

const navigation = [
  { href: "/admin", label: "Overview", superAdminOnly: false },
  { href: "/admin/products", label: "Products", superAdminOnly: false },
  { href: "/admin/categories", label: "Categories", superAdminOnly: false },
  { href: "/admin/orders", label: "Orders", superAdminOnly: false },
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

  const visible = navigation.filter(
    (item) => !item.superAdminOnly || isSuperAdmin(user),
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="bg-blue-600 text-paper">
        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 md:px-6">
          <Link href="/admin" className="font-display text-h3">
            Admin
          </Link>
          <nav aria-label="Admin sections" className="flex-1">
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {visible.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-meta hover:underline">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex items-center gap-3">
            <span className="text-meta">
              {user.email} · {user.role === "super_admin" ? "Super admin" : "Staff"}
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 md:px-6">
        {children}
      </main>
    </div>
  );
}
