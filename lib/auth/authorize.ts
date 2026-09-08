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

const STAFF_ROLES: readonly UserRole[] = ["super_admin", "staff_admin"];

export function isStaff(user: SessionUser | null | undefined): boolean {
  return user != null && STAFF_ROLES.includes(user.role);
}

export function isSuperAdmin(user: SessionUser | null | undefined): boolean {
  return user?.role === "super_admin";
}

export function requireUser(user: SessionUser | null | undefined): SessionUser {
  if (!user) throw new AuthenticationError();
  return user;
}

/**
 * Staff-or-above. This is the gate on every product, variant, category,
 * attribute, and media mutation: a customer account can never pass it, under
 * any code path (MASTER_PRODUCT_SPEC.md business model statement).
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

/**
 * super_admin only: managing other admin accounts, site settings, and
 * financial/margin reporting. Enumerated in docs/BUSINESS_LOGIC.md.
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
 * only visible to the user who owns it, or to staff.
 */
export function requireOwnerOrStaff(
  user: SessionUser | null | undefined,
  ownerUserId: string | null,
): SessionUser {
  const current = requireUser(user);
  if (isStaff(current)) return current;
  if (ownerUserId && ownerUserId === current.id) return current;
  throw new AuthorizationError();
}
