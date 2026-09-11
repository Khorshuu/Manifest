import type { Metadata } from "next";
import { listSettings } from "@/lib/admin";
import { isSuperAdmin } from "@/lib/auth";
import { SettingRow } from "./setting-row";
import { requireAdminPage } from "@/lib/auth/admin-page";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await requireAdminPage("settings.manage");
  const settings = await listSettings(user);
  const canEdit = isSuperAdmin(user);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
          <span aria-hidden="true" className="h-px w-8 bg-brass" />
          Operations
        </p>
        <h1 className="mt-2 font-display text-h1 text-ink">Settings</h1>
        <p className="mt-2 max-w-[70ch] text-meta text-ink/70">
          Staff can read these; only a super admin can change them, and every
          change is written to the audit log with the value it replaced.
        </p>
      </div>

      {!canEdit ? (
        <p className="border border-blue-300 p-4 text-meta text-ink">
          You can see these values but not change them.
        </p>
      ) : null}

      <p className="border border-brass bg-brass/10 p-4 text-meta text-ink">
        The shipping and duty figures do not change what anyone is charged. A
        price is a landed price — these only decide how it is broken down on an
        order, so the shop can see what a sale is actually made of.
      </p>

      <ul className="border-t border-blue-300">
        {settings.map((setting) => (
          <SettingRow
            key={setting.key}
            settingKey={setting.key}
            label={setting.label}
            hint={setting.hint}
            value={setting.value}
            isDefault={setting.isDefault}
            canEdit={canEdit}
          />
        ))}
      </ul>
    </div>
  );
}
