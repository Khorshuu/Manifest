import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { addresses, orders } from "@/db/schema";
import { requireUser, type SessionUser } from "@/lib/auth";

/**
 * An account's address book.
 *
 * Orders point at an address row rather than copying it, so an address an
 * order was delivered to must never change underneath that order. Two rules
 * follow, and both live here rather than in a route:
 *
 *  * Editing an address that an order used writes a new row and retires the
 *    old one from the book. The order keeps pointing at what was true.
 *  * Removing such an address detaches it from the account (`user_id` null)
 *    instead of deleting it. Only an address no order has used is deleted.
 */

export type AddressInput = {
  label?: string;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  district: string;
  postalCode?: string;
};

export class AddressError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AddressError";
    this.status = status;
  }
}

/** The most an account keeps. Enough for home, work and family, not a list. */
export const MAX_ADDRESSES = 10;

export async function listAddresses(userId: string) {
  return db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), asc(addresses.createdAt));
}

function values(input: AddressInput) {
  return {
    label: input.label?.trim() || null,
    recipientName: input.recipientName,
    phone: input.phone,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2?.trim() || null,
    city: input.city,
    district: input.district,
    postalCode: input.postalCode?.trim() || null,
  };
}

async function ownedAddress(userId: string, addressId: string) {
  const [row] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
    .limit(1);

  // Someone else's address and a missing one read the same, so an id cannot
  // be used to learn that another account's address exists.
  if (!row) throw new AddressError("That address was not found.", 404);
  return row;
}

async function isUsedByAnOrder(addressId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.shippingAddressId, addressId))
    .limit(1);
  return Boolean(row);
}

export async function createAddress(
  actor: SessionUser | null,
  input: AddressInput & { makeDefault?: boolean },
) {
  const user = requireUser(actor);
  const existing = await listAddresses(user.id);

  if (existing.length >= MAX_ADDRESSES) {
    throw new AddressError(
      `An account keeps up to ${MAX_ADDRESSES} addresses. Remove one first.`,
    );
  }

  // The first address is the default whether or not it was asked for — a
  // book with addresses and no default leaves checkout guessing.
  const makeDefault = input.makeDefault || existing.length === 0;

  return db.transaction(async (tx) => {
    if (makeDefault) {
      await tx
        .update(addresses)
        .set({ isDefault: false })
        .where(eq(addresses.userId, user.id));
    }

    const [created] = await tx
      .insert(addresses)
      .values({ ...values(input), userId: user.id, isDefault: makeDefault })
      .returning();

    return created;
  });
}

export async function updateAddress(
  actor: SessionUser | null,
  addressId: string,
  input: AddressInput & { makeDefault?: boolean },
) {
  const user = requireUser(actor);
  const current = await ownedAddress(user.id, addressId);
  const makeDefault = input.makeDefault ?? current.isDefault;
  const used = await isUsedByAnOrder(addressId);

  return db.transaction(async (tx) => {
    if (makeDefault) {
      await tx
        .update(addresses)
        .set({ isDefault: false })
        .where(eq(addresses.userId, user.id));
    }

    if (!used) {
      const [updated] = await tx
        .update(addresses)
        .set({ ...values(input), isDefault: makeDefault, updatedAt: new Date() })
        .where(eq(addresses.id, addressId))
        .returning();
      return updated;
    }

    // Copy-on-write: the old row stays exactly as the order saw it.
    await tx
      .update(addresses)
      .set({ userId: null, isDefault: false, updatedAt: new Date() })
      .where(eq(addresses.id, addressId));

    const [replacement] = await tx
      .insert(addresses)
      .values({ ...values(input), userId: user.id, isDefault: makeDefault })
      .returning();
    return replacement;
  });
}

export async function setDefaultAddress(
  actor: SessionUser | null,
  addressId: string,
) {
  const user = requireUser(actor);
  await ownedAddress(user.id, addressId);

  await db.transaction(async (tx) => {
    await tx
      .update(addresses)
      .set({ isDefault: false })
      .where(eq(addresses.userId, user.id));
    await tx
      .update(addresses)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(addresses.id, addressId));
  });
}

export async function removeAddress(
  actor: SessionUser | null,
  addressId: string,
) {
  const user = requireUser(actor);
  const current = await ownedAddress(user.id, addressId);
  const used = await isUsedByAnOrder(addressId);

  await db.transaction(async (tx) => {
    if (used) {
      await tx
        .update(addresses)
        .set({ userId: null, isDefault: false, updatedAt: new Date() })
        .where(eq(addresses.id, addressId));
    } else {
      await tx.delete(addresses).where(eq(addresses.id, addressId));
    }

    // Removing the default hands it to the oldest remaining address.
    if (current.isDefault) {
      const [next] = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.userId, user.id), ne(addresses.id, addressId)))
        .orderBy(asc(addresses.createdAt))
        .limit(1);

      if (next) {
        await tx
          .update(addresses)
          .set({ isDefault: true })
          .where(eq(addresses.id, next.id));
      }
    }
  });
}

/** Whether an account has any address saved — used by checkout. */
export async function countAddresses(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(addresses)
    .where(eq(addresses.userId, userId));
  return Number(row?.value ?? 0);
}
