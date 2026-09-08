import { eq } from "drizzle-orm";
import { db } from "@/db";
import { addresses, orders, users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/authorize";
import { invalidateAllUserSessions } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Handling a deletion request.
 *
 * Personal data is replaced, while the orders and payments that reference the
 * account are kept: financial records have to survive for tax and consumer
 * protection, and deleting an order outright would also corrupt every revenue
 * figure that has already been reported (docs/SECURITY.md).
 */

export class AnonymisationError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "AnonymisationError";
  }
}

/** A stable, meaningless stand-in for a removed value. */
function redacted(userId: string, field: string): string {
  return `redacted-${field}-${userId.slice(0, 8)}`;
}

export async function anonymiseCustomer(
  actor: SessionUser | null,
  userId: string,
) {
  const admin = requireSuperAdmin(actor);

  const [subject] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId));

  if (!subject) throw new AnonymisationError("That account no longer exists.");

  if (subject.role !== "customer") {
    throw new AnonymisationError(
      "Only a customer account can be anonymised. Change the role first.",
    );
  }

  const result = await db.transaction(async (tx) => {
    // The email must stay unique, so it is replaced rather than blanked.
    const [updated] = await tx
      .update(users)
      .set({
        email: `${redacted(userId, "email")}@example.invalid`,
        phone: null,
        // A password nobody holds: the account can never be signed into again.
        passwordHash: "anonymised",
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email });

    // Addresses carry a name, a phone number, and where someone lives.
    await tx
      .update(addresses)
      .set({
        recipientName: redacted(userId, "name"),
        phone: redacted(userId, "phone"),
        addressLine1: redacted(userId, "address"),
        addressLine2: null,
        postalCode: null,
        updatedAt: new Date(),
      })
      .where(eq(addresses.userId, userId));

    // Guest contact details recorded on the orders themselves.
    await tx
      .update(orders)
      .set({
        guestEmail: `${redacted(userId, "email")}@example.invalid`,
        guestPhone: null,
      })
      .where(eq(orders.userId, userId));

    await recordAudit(
      {
        actorUserId: admin.id,
        action: "user.deactivated",
        entityType: "user",
        entityId: userId,
        before: { email: subject.email },
        after: { email: updated.email, anonymised: true },
      },
      tx,
    );

    return updated;
  });

  // Any open session is now meaningless and must not keep working.
  await invalidateAllUserSessions(userId);

  return result;
}
