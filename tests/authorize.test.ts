import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
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
