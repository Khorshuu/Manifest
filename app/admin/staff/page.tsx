import type { Metadata } from "next";
import { listStaff } from "@/lib/admin";
import { STAFF_PASSWORD_MIN } from "@/lib/admin/staff";
import { PERMISSIONS, ROLE_DETAILS, ROLE_PERMISSIONS, STAFF_ROLES } from "@/lib/auth";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { StaffManager } from "./staff-manager";

export const metadata: Metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

/** Plain names for the permission table, in the order the admin nav uses. */
const PERMISSION_LABELS: Record<(typeof PERMISSIONS)[number], string> = {
  "orders.view": "See orders",
  "orders.manage": "Change orders",
  "catalog.manage": "Products & categories",
  "customers.view": "Customers",
  "homepage.manage": "Homepage",
  "reviews.moderate": "Reviews",
  "search.manage": "Search",
  "notifications.view": "Notifications",
  "analytics.view": "Analytics",
  "finance.view": "Revenue & margin",
  "audit.view": "Audit log",
  "staff.manage": "Staff",
  "settings.manage": "Settings",
};

export default async function AdminStaffPage() {
  // Gated in the layout too, and again inside listStaff.
  const user = await requireAdminPage("staff.manage");
  const staff = await listStaff(user);

  const roles = STAFF_ROLES.map((role) => ({
    value: role,
    label: ROLE_DETAILS[role].label,
    summary: ROLE_DETAILS[role].summary,
  }));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <h1 className="font-display text-h1 text-ink">Staff</h1>
        <p className="mt-1 text-meta text-ink/70">
          {staff.length} staff account{staff.length === 1 ? "" : "s"}. A role
          decides which sections someone sees and what the server lets them do.
        </p>
      </div>

      <StaffManager
        roles={roles}
        passwordMin={STAFF_PASSWORD_MIN}
        staff={staff.map((member) => ({
          id: member.id,
          email: member.email,
          firstName: member.firstName,
          role: member.role,
          isSelf: member.id === user.id,
        }))}
      />

      <section className="admin-card min-w-0">
        <h2 className="admin-h2">What each role can do</h2>

        {/* Narrow screens: one block per role, listing what it allows. A
            matrix of nine columns is unreadable a column at a time, and the
            question a phone is asking is "what can this role do", not "who
            has this one permission". */}
        <ul className="mt-3 flex flex-col gap-3 lg:hidden">
          {STAFF_ROLES.map((role) => {
            const allowed = PERMISSIONS.filter((permission) =>
              ROLE_PERMISSIONS[role].includes(permission),
            );
            return (
              <li
                key={role}
                className="rounded-card border border-blue-200 p-3"
              >
                <p className="font-semibold text-ink">{ROLE_DETAILS[role].label}</p>
                {allowed.length === 0 ? (
                  <p className="mt-1 text-[0.75rem] text-ink/70">
                    Nothing in the admin.
                  </p>
                ) : (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {allowed.map((permission) => (
                      <li key={permission} className="admin-chip">
                        {PERMISSION_LABELS[permission]}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        <div className="relative mt-3 hidden overflow-x-auto lg:block">
          <table className="admin-table min-w-[760px]">
            <thead>
              <tr>
                <th scope="col">Role</th>
                {PERMISSIONS.map((permission) => (
                  <th key={permission} scope="col" className="text-center">
                    {PERMISSION_LABELS[permission]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {STAFF_ROLES.map((role) => (
                <tr key={role}>
                  <th scope="row" className="whitespace-nowrap font-semibold text-ink">
                    {ROLE_DETAILS[role].label}
                  </th>
                  {PERMISSIONS.map((permission) => {
                    const has = ROLE_PERMISSIONS[role].includes(permission);
                    return (
                      <td key={permission} className="text-center">
                        <span aria-hidden="true" className={has ? "text-transit-green-text" : "text-ink/25"}>
                          {has ? "●" : "–"}
                        </span>
                        <span className="sr-only">{has ? "Yes" : "No"}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
