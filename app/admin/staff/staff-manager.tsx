"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";

export type StaffRow = {
  id: string;
  email: string;
  firstName: string | null;
  role: string;
  isSelf: boolean;
};

export type RoleOption = { value: string; label: string; summary: string };

/**
 * Staff accounts and their roles.
 *
 * Each account has one role, chosen from a named list with what it allows
 * written beside it. The old "Change to" row of buttons — which offered to
 * turn anyone into a customer or a super admin with one unlabelled click —
 * is gone; removing someone's access is a separate, explicit action.
 */
export function StaffManager({
  staff,
  roles,
  passwordMin,
}: {
  staff: StaffRow[];
  roles: RoleOption[];
  passwordMin: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newRole, setNewRole] = useState(roles.find((r) => r.value === "staff_admin")?.value ?? roles[0]?.value ?? "");

  const labelOf = (role: string) => roles.find((r) => r.value === role)?.label ?? role;

  async function send(
    key: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    success: string,
  ) {
    setPending(key);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/admin/staff", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    setPending(null);

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
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    const created = await send(
      "create",
      "POST",
      {
        email: form.get("email"),
        firstName: form.get("firstName") || undefined,
        password: form.get("password"),
        role: newRole,
      },
      "Account created.",
    );

    if (created) formElement.reset();
  }

  const selectClass =
    "min-h-9 rounded-control border border-blue-300 bg-paper px-2 text-meta text-ink";

  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="admin-card min-w-0">
        <h2 className="admin-h2">Current staff</h2>

        <div aria-live="polite" className="mt-2 min-h-5 text-meta">
          {error ? <p className="text-stamp-red-text">{error}</p> : null}
          {message ? <p className="text-transit-green-text">{message}</p> : null}
        </div>

        <div className="relative mt-2 overflow-x-auto">
          <table className="admin-table min-w-[560px]">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col" className="text-right">Access</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((member) => {
                const chosen = draft[member.id] ?? member.role;
                const changed = chosen !== member.role;
                return (
                  <tr key={member.id}>
                    <td>
                      <span className="block font-medium text-ink">
                        {member.firstName ?? member.email.split("@")[0]}
                        {member.isSelf ? (
                          <span className="ml-1.5 text-ink/70">(you)</span>
                        ) : null}
                      </span>
                      <span className="block text-ink/70">{member.email}</span>
                    </td>
                    <td>
                      {member.isSelf ? (
                        // Changing your own role is refused server-side too.
                        <span className="text-ink">{labelOf(member.role)}</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="sr-only" htmlFor={`role-${member.id}`}>
                            Role for {member.email}
                          </label>
                          <select
                            id={`role-${member.id}`}
                            value={chosen}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                [member.id]: event.target.value,
                              }))
                            }
                            className={selectClass}
                          >
                            {roles.map((role) => (
                              <option key={role.value} value={role.value}>
                                {role.label}
                              </option>
                            ))}
                          </select>
                          {changed ? (
                            <Button
                              type="button"
                              size="sm"
                              disabled={pending !== null}
                              onClick={() =>
                                send(
                                  member.id,
                                  "PATCH",
                                  { userId: member.id, role: chosen },
                                  `${member.email} is now ${labelOf(chosen)}.`,
                                ).then((ok) => {
                                  if (ok)
                                    setDraft((current) => {
                                      const next = { ...current };
                                      delete next[member.id];
                                      return next;
                                    });
                                })
                              }
                            >
                              {pending === member.id ? "Saving…" : "Save role"}
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="text-right">
                      {member.isSelf ? null : (
                        <button
                          type="button"
                          disabled={pending !== null}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Remove staff access for ${member.email}? They keep a customer account.`,
                              )
                            )
                              return;
                            void send(
                              `revoke-${member.id}`,
                              "PATCH",
                              { userId: member.id, role: "customer" },
                              `${member.email} no longer has staff access.`,
                            );
                          }}
                          className="min-h-9 rounded-control px-2 text-meta font-medium text-stamp-red-text hover:bg-stamp-red/5 disabled:opacity-50"
                        >
                          Remove access
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-meta text-ink/70">
          Changing a role signs that account out everywhere, so it takes effect
          at once.
        </p>
      </section>

      <section className="admin-card min-w-0">
        <h2 className="admin-h2">Add a staff account</h2>

        <form onSubmit={onCreate} className="mt-3 flex flex-col gap-4" noValidate>
          <Field label="First name" name="firstName" autoComplete="off" />
          <Field label="Email" name="email" type="email" required />
          <Field
            label="Temporary password"
            name="password"
            type="password"
            required
            minLength={passwordMin}
            hint={`At least ${passwordMin} characters. Ask them to change it after signing in.`}
          />

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-meta font-medium text-ink">Role</legend>
            {roles.map((role) => (
              <label
                key={role.value}
                className={`flex cursor-pointer items-start gap-2 rounded-control border px-2.5 py-2 text-meta transition-colors ${
                  newRole === role.value
                    ? "border-blue-600 bg-blue-50"
                    : "border-blue-200 hover:border-blue-400"
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value={role.value}
                  checked={newRole === role.value}
                  onChange={() => setNewRole(role.value)}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span>
                  <span className="block font-semibold text-ink">{role.label}</span>
                  <span className="block text-ink/70">{role.summary}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <Button type="submit" disabled={pending !== null}>
            {pending === "create" ? "Working…" : "Create account"}
          </Button>
        </form>
      </section>
    </div>
  );
}
