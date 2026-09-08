"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";

export type StaffRow = {
  id: string;
  email: string;
  role: string;
  isSelf: boolean;
};

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super admin",
  staff_admin: "Staff",
  customer: "Customer",
};

export function StaffManager({ staff }: { staff: StaffRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    success: string,
  ) {
    setPending(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/admin/staff", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "Something went wrong. Try again.");
      return false;
    }

    setMessage(success);
    router.refresh();
    return true;
  }

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const created = await send(
      "POST",
      {
        email: form.get("email"),
        password: form.get("password"),
        role: form.get("role"),
      },
      "Account created.",
    );

    if (created) (event.target as HTMLFormElement).reset();
  }

  return (
    <div className="grid items-start gap-10 lg:grid-cols-[1fr_360px]">
      {/* min-w-0: without it the scrollable table widens this grid track and
          overlaps the form on a narrow screen. */}
      <section className="min-w-0">
        <h2 className="font-display text-h2 text-ink">Current staff</h2>

        <div className="mt-4 overflow-x-auto border border-blue-300">
          <table className="w-full min-w-[560px] border-collapse text-body">
            <thead>
              <tr className="text-left">
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Email
                </th>
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Role
                </th>
                <th scope="col" className="px-4 py-3 text-meta font-medium">
                  Change to
                </th>
              </tr>
            </thead>
            <tbody>
              {staff.map((member, index) => (
                <tr
                  key={member.id}
                  className={index % 2 === 1 ? "bg-blue-200/40" : undefined}
                >
                  <td className="border-t border-blue-300 px-4 py-3">
                    {member.email}
                    {member.isSelf ? (
                      <span className="ml-2 text-meta text-ink/70">(you)</span>
                    ) : null}
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3 text-meta text-ink/70">
                    {ROLE_LABELS[member.role] ?? member.role}
                  </td>
                  <td className="border-t border-blue-300 px-4 py-3">
                    {member.isSelf ? (
                      // Changing your own role is refused server-side too.
                      <span className="text-meta text-ink/70">
                        Ask another super admin
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {(["super_admin", "staff_admin", "customer"] as const)
                          .filter((role) => role !== member.role)
                          .map((role) => (
                            <button
                              key={role}
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                send(
                                  "PATCH",
                                  { userId: member.id, role },
                                  `${member.email} is now ${ROLE_LABELS[role]}.`,
                                )
                              }
                              className="min-h-11 rounded-control border border-blue-300 px-3 text-meta text-blue-600 disabled:opacity-60"
                            >
                              {ROLE_LABELS[role]}
                            </button>
                          ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 max-w-[70ch] text-meta text-ink/70">
          Changing a role signs that account out everywhere, so the new role
          takes effect at once rather than when their session happens to expire.
        </p>
      </section>

      <section className="min-w-0">
        <h2 className="font-display text-h2 text-ink">Add a staff account</h2>

        <form onSubmit={onCreate} className="mt-4 flex flex-col gap-5" noValidate>
          <Field label="Email" name="email" type="email" required />
          <Field
            label="Temporary password"
            name="password"
            type="password"
            required
            hint="At least 10 characters. Ask them to change it after signing in."
          />

          <div className="flex flex-col gap-2">
            <label htmlFor="role" className="text-meta font-medium text-ink">
              Role
            </label>
            <select
              id="role"
              name="role"
              defaultValue="staff_admin"
              className="min-h-11 rounded-control border border-blue-300 px-3 text-body"
            >
              <option value="staff_admin">Staff</option>
              <option value="super_admin">Super admin</option>
            </select>
          </div>

          <div aria-live="polite" className="flex flex-col gap-1">
            {error ? <p className="text-meta text-stamp-red-text">{error}</p> : null}
            {message ? (
              <p className="text-meta text-transit-green-text">{message}</p>
            ) : null}
          </div>

          <Button type="submit" disabled={pending}>
            {pending ? "Working…" : "Create account"}
          </Button>
        </form>
      </section>
    </div>
  );
}
