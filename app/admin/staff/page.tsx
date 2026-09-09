import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listStaff } from "@/lib/admin";
import { getCurrentUser, isSuperAdmin } from "@/lib/auth";
import { StaffManager } from "./staff-manager";

export const metadata: Metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

export default async function AdminStaffPage() {
  const user = await getCurrentUser();

  // Gated in the layout too, and again inside listStaff. This redirect is for
  // a tidy experience, not for security.
  if (!isSuperAdmin(user)) redirect("/admin");

  const staff = await listStaff(user);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Operations
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Staff</h1>
      </div>

      <StaffManager
        staff={staff.map((member) => ({
          id: member.id,
          email: member.email,
          role: member.role,
          isSelf: member.id === user!.id,
        }))}
      />
    </div>
  );
}
