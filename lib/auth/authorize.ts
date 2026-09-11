import type { SessionUser } from "./session";
import type { UserRole } from "@/db/schema";

/**
 * Authorization primitives. These are called from inside `lib/` functions, not
 * only from route handlers, so a future caller that forgets a middleware check
 * still cannot succeed — see docs/SECURITY.md.
 */

export class AuthorizationError extends Error {
  readonly status = 403;

  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class AuthenticationError extends Error {
  readonly status = 401;

  constructor(message = "You need to sign in to do that.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

/**
 * What a staff account may do, one capability per area of the admin.
 *
 * A role is a named list of these (DECISIONS.md D-034). Every gated function
 * in `lib/` asks for exactly one, so a role is changed by editing the table
 * below rather than by hunting for role comparisons across the codebase.
 */
export const PERMISSIONS = [
  /** Products, variants, categories, specifications, photography, windows. */
  "catalog.manage",
  /** The homepage campaigns: hero photographs and showcase tiles. */
  "homepage.manage",
  /** Synonyms, the search index, and the search report. */
  "search.manage",
  /** Approving and rejecting customer reviews. */
  "reviews.moderate",
  /** Reading orders and their history. */
  "orders.view",
  /** Moving an order on: status, shipping, balance, refunds, cancellations. */
  "orders.manage",
  /** Customer accounts and what each has ordered. */
  "customers.view",
  /** The notification outbox. */
  "notifications.view",
  /** Non-financial analytics: funnels, order volume, signups, preorders. */
  "analytics.view",
  /** Money: revenue, collected amounts, margin. */
  "finance.view",
  /** The audit log. */
  "audit.view",
  /** Creating staff accounts and assigning roles. */
  "staff.manage",
  /** Site-wide settings that decide prices and policy. */
  "settings.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const STAFF_ROLES = [
  "super_admin",
  "staff_admin",
  "product_manager",
  "order_manager",
  "support",
  "marketing",
  "finance",
] as const satisfies readonly UserRole[];

export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * The roles, as a shop of this size actually divides the work.
 *
 * `staff_admin` keeps the capability it always had, renamed "Operations
 * manager" in the interface, so no existing account gains or loses anything
 * by this change. The owner (`super_admin`) holds every permission.
 */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  staff_admin: [
    "catalog.manage",
    "homepage.manage",
    "search.manage",
    "reviews.moderate",
    "orders.view",
    "orders.manage",
    "notifications.view",
    "analytics.view",
    "audit.view",
  ],
  product_manager: ["catalog.manage", "search.manage", "reviews.moderate"],
  order_manager: [
    "orders.view",
    "orders.manage",
    "customers.view",
    "notifications.view",
  ],
  support: [
    "orders.view",
    "customers.view",
    "notifications.view",
    "reviews.moderate",
  ],
  marketing: [
    "homepage.manage",
    "search.manage",
    "analytics.view",
    "reviews.moderate",
  ],
  finance: ["finance.view", "analytics.view", "orders.view", "customers.view"],
};

/** How each role is named and explained on the staff screen. */
export const ROLE_DETAILS: Record<StaffRole, { label: string; summary: string }> = {
  super_admin: {
    label: "Owner",
    summary: "Everything, including staff, settings and money.",
  },
  staff_admin: {
    label: "Operations manager",
    summary: "Catalogue, homepage, orders and reviews. No money, staff or settings.",
  },
  product_manager: {
    label: "Product manager",
    summary: "Products, categories, photography, search and reviews.",
  },
  order_manager: {
    label: "Order manager",
    summary: "Orders and fulfilment, customers and notifications.",
  },
  support: {
    label: "Customer support",
    summary: "Reads orders and customers, moderates reviews. Cannot change orders.",
  },
  marketing: {
    label: "Marketing",
    summary: "Homepage campaigns, search, reviews and non-financial analytics.",
  },
  finance: {
    label: "Finance",
    summary: "Revenue and analytics, read-only orders and customers.",
  },
};

export function isStaffRole(role: string): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

export function isStaff(user: SessionUser | null | undefined): boolean {
  return user != null && isStaffRole(user.role);
}

export function isSuperAdmin(user: SessionUser | null | undefined): boolean {
  return user?.role === "super_admin";
}

/** Whether this account holds a permission. A customer holds none. */
export function can(
  user: SessionUser | null | undefined,
  permission: Permission,
): boolean {
  if (!user || !isStaffRole(user.role)) return false;
  return ROLE_PERMISSIONS[user.role].includes(permission);
}

export function permissionsOf(
  user: SessionUser | null | undefined,
): readonly Permission[] {
  if (!user || !isStaffRole(user.role)) return [];
  return ROLE_PERMISSIONS[user.role];
}

export function requireUser(user: SessionUser | null | undefined): SessionUser {
  if (!user) throw new AuthenticationError();
  return user;
}

/**
 * Any staff role. Only for what every staff member may see — the overview's
 * non-financial figures. Anything more specific asks for a permission.
 */
export function requireStaff(user: SessionUser | null | undefined): SessionUser {
  const current = requireUser(user);
  if (!isStaff(current)) {
    throw new AuthorizationError(
      "Only staff and administrators can manage listings and product media.",
    );
  }
  return current;
}

const PERMISSION_REFUSALS: Partial<Record<Permission, string>> = {
  "catalog.manage":
    "Only staff with catalogue access can manage listings and product media.",
  "homepage.manage": "Your role cannot change the homepage.",
  "orders.manage": "Your role can read orders but not change them.",
  "finance.view": "Your role cannot see financial figures.",
  "staff.manage": "Only the owner can manage staff.",
  "settings.manage": "Only the owner can change site settings.",
};

/**
 * The gate every admin function uses. A customer is refused with the same
 * wording as before; a staff member without the permission is told what their
 * role does not allow.
 */
export function requirePermission(
  user: SessionUser | null | undefined,
  permission: Permission,
): SessionUser {
  const current = requireUser(user);
  if (!can(current, permission)) {
    throw new AuthorizationError(
      isStaff(current)
        ? (PERMISSION_REFUSALS[permission] ??
            "Your role does not allow that.")
        : "Only staff and administrators can manage listings and product media.",
    );
  }
  return current;
}

/** Passes when the account holds at least one of the permissions. */
export function requireAnyPermission(
  user: SessionUser | null | undefined,
  permissions: readonly Permission[],
): SessionUser {
  const current = requireUser(user);
  if (!permissions.some((permission) => can(current, permission))) {
    throw new AuthorizationError(
      isStaff(current)
        ? "Your role does not allow that."
        : "Only staff and administrators can manage listings and product media.",
    );
  }
  return current;
}

/**
 * super_admin only: managing other admin accounts, site settings, and
 * anonymising a customer. Enumerated in docs/BUSINESS_LOGIC.md.
 */
export function requireSuperAdmin(
  user: SessionUser | null | undefined,
): SessionUser {
  const current = requireUser(user);
  if (!isSuperAdmin(current)) {
    throw new AuthorizationError(
      "Only a super administrator can do that.",
    );
  }
  return current;
}

/**
 * Ownership check for account-scoped reads: an order, address, or review is
 * only visible to the user who owns it, or to staff whose role reads orders.
 */
export function requireOwnerOrStaff(
  user: SessionUser | null | undefined,
  ownerUserId: string | null,
): SessionUser {
  const current = requireUser(user);
  if (can(current, "orders.view")) return current;
  if (ownerUserId && ownerUserId === current.id) return current;
  throw new AuthorizationError();
}
