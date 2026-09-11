import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
  can,
  PERMISSIONS,
  requirePermission,
  STAFF_ROLES,
  isStaff,
  isSuperAdmin,
  requireOwnerOrStaff,
  requireStaff,
  requireSuperAdmin,
  requireUser,
} from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

const superAdmin: SessionUser = {
  id: "u-1",
  email: "admin@example.com",
  role: "super_admin",
};
const staffAdmin: SessionUser = {
  id: "u-2",
  email: "staff@example.com",
  role: "staff_admin",
};
const customer: SessionUser = {
  id: "u-3",
  email: "customer@example.com",
  role: "customer",
};

describe("role predicates", () => {
  it("treats both admin roles as staff, and a customer as not staff", () => {
    expect(isStaff(superAdmin)).toBe(true);
    expect(isStaff(staffAdmin)).toBe(true);
    expect(isStaff(customer)).toBe(false);
    expect(isStaff(null)).toBe(false);
    expect(isStaff(undefined)).toBe(false);
  });

  it("treats only super_admin as super admin", () => {
    expect(isSuperAdmin(superAdmin)).toBe(true);
    expect(isSuperAdmin(staffAdmin)).toBe(false);
    expect(isSuperAdmin(customer)).toBe(false);
  });
});

describe("requireStaff", () => {
  /**
   * The hard invariant from MASTER_PRODUCT_SPEC.md: a customer account cannot
   * create or edit listings or product media under any circumstance.
   */
  it("rejects a customer", () => {
    expect(() => requireStaff(customer)).toThrow(AuthorizationError);
  });

  it("rejects an anonymous visitor as unauthenticated, not forbidden", () => {
    expect(() => requireStaff(null)).toThrow(AuthenticationError);
  });

  it("allows both admin roles", () => {
    expect(requireStaff(staffAdmin)).toBe(staffAdmin);
    expect(requireStaff(superAdmin)).toBe(superAdmin);
  });
});

describe("requireSuperAdmin", () => {
  it("rejects a staff admin, since admin management and settings are gated", () => {
    expect(() => requireSuperAdmin(staffAdmin)).toThrow(AuthorizationError);
  });

  it("allows a super admin", () => {
    expect(requireSuperAdmin(superAdmin)).toBe(superAdmin);
  });
});

describe("staff roles and permissions", () => {
  const as = (role: SessionUser["role"]): SessionUser => ({ id: role, email: `${role}@example.com`, role });

  it("gives the owner every permission", () => {
    for (const permission of PERMISSIONS) expect(can(superAdmin, permission)).toBe(true);
  });

  it("keeps the operations manager's original reach: no money, staff, settings or customers", () => {
    expect(can(staffAdmin, "catalog.manage")).toBe(true);
    expect(can(staffAdmin, "orders.manage")).toBe(true);
    expect(can(staffAdmin, "finance.view")).toBe(false);
    expect(can(staffAdmin, "staff.manage")).toBe(false);
    expect(can(staffAdmin, "settings.manage")).toBe(false);
    expect(can(staffAdmin, "customers.view")).toBe(false);
  });

  it("confines each role to its own work", () => {
    expect(can(as("product_manager"), "catalog.manage")).toBe(true);
    expect(can(as("product_manager"), "orders.view")).toBe(false);
    expect(can(as("order_manager"), "orders.manage")).toBe(true);
    expect(can(as("order_manager"), "catalog.manage")).toBe(false);
    expect(can(as("support"), "orders.view")).toBe(true);
    expect(can(as("support"), "orders.manage")).toBe(false);
    expect(can(as("marketing"), "homepage.manage")).toBe(true);
    expect(can(as("marketing"), "finance.view")).toBe(false);
    expect(can(as("finance"), "finance.view")).toBe(true);
    expect(can(as("finance"), "homepage.manage")).toBe(false);
  });

  it("gives a customer nothing, and only the owner staff management", () => {
    for (const permission of PERMISSIONS) expect(can(customer, permission)).toBe(false);
    for (const role of STAFF_ROLES) {
      expect(can(as(role), "staff.manage")).toBe(role === "super_admin");
    }
  });

  it("treats every staff role as staff for the admin shell", () => {
    for (const role of STAFF_ROLES) expect(isStaff(as(role))).toBe(true);
  });

  it("refuses with the permission's own wording", () => {
    expect(() => requirePermission(as("support"), "orders.manage")).toThrow(/read orders but not change/);
    expect(() => requirePermission(customer, "catalog.manage")).toThrow(AuthorizationError);
    expect(() => requirePermission(null, "catalog.manage")).toThrow(AuthenticationError);
  });

  it("lets only order-reading roles see another person's order", () => {
    expect(() => requireOwnerOrStaff(as("product_manager"), "someone-else")).toThrow(AuthorizationError);
    expect(requireOwnerOrStaff(as("support"), "someone-else").role).toBe("support");
  });
});

describe("requireUser", () => {
  it("rejects null and undefined", () => {
    expect(() => requireUser(null)).toThrow(AuthenticationError);
    expect(() => requireUser(undefined)).toThrow(AuthenticationError);
  });
});

describe("requireOwnerOrStaff", () => {
  it("allows the owner", () => {
    expect(requireOwnerOrStaff(customer, customer.id)).toBe(customer);
  });

  it("rejects a different customer", () => {
    expect(() => requireOwnerOrStaff(customer, "someone-else")).toThrow(
      AuthorizationError,
    );
  });

  it("rejects a customer when the record has no owner, rather than defaulting open", () => {
    expect(() => requireOwnerOrStaff(customer, null)).toThrow(
      AuthorizationError,
    );
  });

  it("allows staff to view another user's record", () => {
    expect(requireOwnerOrStaff(staffAdmin, "someone-else")).toBe(staffAdmin);
  });
});
