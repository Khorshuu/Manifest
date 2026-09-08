/**
 * Site settings.
 *
 * Two rules: only a super admin may change one, and a bad or missing row must
 * never take the storefront down — a settings table someone edited by hand
 * falls back to the built-in default instead.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, siteSettings, users } from "@/db/schema";
import {
  getSetting,
  getSettings,
  listSettings,
  SettingError,
  updateSetting,
} from "@/lib/admin";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const superAdmin: SessionUser = {
  id: "",
  email: "admin@example.com",
  role: "super_admin",
};
const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const customer: SessionUser = {
  id: "",
  email: "shopper@example.com",
  role: "customer",
};

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "admin@example.com", passwordHash: "x", role: "super_admin" },
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  superAdmin.id = rows.find((r) => r.email === "admin@example.com")!.id;
  staff.id = rows.find((r) => r.email === "staff@example.com")!.id;
  customer.id = rows.find((r) => r.email === "shopper@example.com")!.id;
});

describe("reading", () => {
  it("falls back to the default when nothing is stored", async () => {
    expect(await getSetting("landed.duty_percent")).toBe(32);
  });

  it("returns the stored value once set", async () => {
    await updateSetting(superAdmin, "landed.duty_percent", 25);
    expect(await getSetting("landed.duty_percent")).toBe(25);
  });

  /** A hand-edited row must not be able to break a checkout. */
  it("falls back rather than throwing on a corrupt value", async () => {
    await harness.db.insert(siteSettings).values({
      key: "landed.duty_percent",
      valueJson: { value: "not a number" },
      updatedBy: superAdmin.id,
    });

    expect(await getSetting("landed.duty_percent")).toBe(32);
  });

  it("reads several at once", async () => {
    await updateSetting(superAdmin, "landed.shipping_per_kg_bdt", 700_00);

    const values = await getSettings([
      "landed.shipping_per_kg_bdt",
      "landed.assumed_weight_grams",
    ]);

    expect(values["landed.shipping_per_kg_bdt"]).toBe(700_00);
    expect(values["landed.assumed_weight_grams"]).toBe(500);
  });

  it("lists every setting to staff, flagging the ones still on defaults", async () => {
    await updateSetting(superAdmin, "landed.duty_percent", 20);

    const rows = await listSettings(staff);
    const duty = rows.find((row) => row.key === "landed.duty_percent")!;
    const shipping = rows.find(
      (row) => row.key === "landed.shipping_per_kg_bdt",
    )!;

    expect(duty.value).toBe(20);
    expect(duty.isDefault).toBe(false);
    expect(shipping.isDefault).toBe(true);
  });

  it("refuses a customer reading the list", async () => {
    await expect(listSettings(customer)).rejects.toThrow(AuthorizationError);
  });
});

describe("writing", () => {
  it("refuses staff who are not super admin", async () => {
    await expect(
      updateSetting(staff, "landed.duty_percent", 10),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses a customer", async () => {
    await expect(
      updateSetting(customer, "landed.duty_percent", 10),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses a key that is not a setting", async () => {
    await expect(
      updateSetting(superAdmin, "something.invented", 1),
    ).rejects.toThrow(SettingError);
  });

  it("refuses a value the setting's own schema rejects", async () => {
    await expect(
      updateSetting(superAdmin, "landed.duty_percent", 500),
    ).rejects.toThrow(SettingError);
    await expect(
      updateSetting(superAdmin, "store.contact_email", "not-an-email"),
    ).rejects.toThrow(SettingError);
  });

  it("overwrites rather than accumulating rows", async () => {
    await updateSetting(superAdmin, "landed.duty_percent", 20);
    await updateSetting(superAdmin, "landed.duty_percent", 22);

    const rows = await harness.db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.key, "landed.duty_percent"));

    expect(rows).toHaveLength(1);
    expect(await getSetting("landed.duty_percent")).toBe(22);
  });

  /** A duty rate changing is exactly what someone will need explained later. */
  it("audits the change with the value it replaced", async () => {
    await updateSetting(superAdmin, "landed.duty_percent", 20);
    await updateSetting(superAdmin, "landed.duty_percent", 30);

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, "landed.duty_percent"));

    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("site_settings.updated");
    expect(entries[1].beforeJson).toEqual({ value: 20 });
    expect(entries[1].afterJson).toEqual({ value: 30 });
  });
});
