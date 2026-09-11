import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, type UserRole } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import {
  requirePermission,
  STAFF_ROLES,
  type StaffRole,
} from "@/lib/auth/authorize";
import { hashPassword } from "@/lib/auth/password";
import { invalidateAllUserSessions } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Staff and role management.
 *
 * Every function here needs `staff.manage`, which only the owner holds:
 * managing other admins is one of the gated actions listed in
 * docs/BUSINESS_LOGIC.md.
 */

/**
 * The shortest temporary password a staff account may be given. Eight, at the
 * owner's request (DECISIONS.md D-034); the other protections are unchanged —
 * argon2id hashing, login rate limiting, and the second factor every staff
 * account is asked to set up.
 */
export const STAFF_PASSWORD_MIN = 8;

export class StaffError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "StaffError";
  }
}

export async function listStaff(actor: SessionUser | null) {
  requirePermission(actor, "staff.manage");

  return db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(inArray(users.role, [...STAFF_ROLES]))
    .orderBy(desc(users.createdAt));
}

export async function createStaffAccount(
  actor: SessionUser | null,
  input: { email: string; password: string; role: StaffRole; firstName?: string },
) {
  if (input.password.length < STAFF_PASSWORD_MIN) {
    throw new StaffError(`Use at least ${STAFF_PASSWORD_MIN} characters.`);
  }
  const admin = requirePermission(actor, "staff.manage");

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (existing.length > 0) {
    throw new StaffError("An account with that email already exists.");
  }

  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        email: input.email,
        firstName: input.firstName?.trim() || null,
        passwordHash,
        role: input.role,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id, email: users.email, role: users.role });

    await recordAudit(
      {
        actorUserId: admin.id,
        action: "user.created",
        entityType: "user",
        entityId: created.id,
        after: { email: created.email, role: created.role },
      },
      tx,
    );

    return created;
  });
}

/**
 * Changes a role.
 *
 * Every session belonging to the account is dropped afterwards: a role change
 * has to take effect immediately, and an open session would otherwise keep
 * whatever it had until it expired.
 */
export async function changeRole(
  actor: SessionUser | null,
  userId: string,
  role: UserRole,
) {
  const admin = requirePermission(actor, "staff.manage");

  if (userId === admin.id) {
    throw new StaffError(
      "You cannot change your own role. Ask another super administrator.",
    );
  }

  const [before] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId));

  if (!before) throw new StaffError("That account no longer exists.");

  // Never leave the site without a super admin.
  if (before.role === "super_admin" && role !== "super_admin") {
    const [{ remaining }] = await db
      .select({ remaining: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, "super_admin"));

    if (remaining <= 1) {
      throw new StaffError(
        "This is the only super administrator. Promote someone else first.",
      );
    }
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email, role: users.role });

    await recordAudit(
      {
        actorUserId: admin.id,
        action: "user.role_changed",
        entityType: "user",
        entityId: userId,
        before: { role: before.role },
        after: { role: row.role },
      },
      tx,
    );

    return row;
  });

  await invalidateAllUserSessions(userId);

  return updated;
}

/** Customer accounts, for the admin customer list. */
export async function listCustomers(
  actor: SessionUser | null,
  options: { limit?: number } = {},
) {
  requirePermission(actor, "customers.view");

  return db
    .select({
      id: users.id,
      email: users.email,
      phone: users.phone,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.role, "customer"))
    .orderBy(desc(users.createdAt))
    .limit(options.limit ?? 100);
}
