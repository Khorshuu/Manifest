/**
 * Account features: wishlist and save-for-later, the address book, newsletter
 * signup and the recently-viewed cookie.
 *
 * The rules worth a test: nobody can touch another account's list or
 * addresses, a saved item carries no price, and an address a past order used
 * is never rewritten or deleted underneath that order.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addresses,
  cartItems,
  newsletterSubscribers,
  orders,
  productVariants,
  users,
  wishlistItems,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import {
  addToWishlist,
  createAddress,
  listAddresses,
  listSavedVariantIds,
  listWishlist,
  moveWishlistItemToCart,
  parseRecentlyViewed,
  pushRecentlyViewed,
  removeAddress,
  removeFromWishlist,
  saveCartItemForLater,
  setDefaultAddress,
  subscribeToNewsletter,
  updateAddress,
} from "@/lib/account";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { createCategory, createProduct } from "@/lib/catalog";
import { setBackgroundDeliveryForTesting } from "@/lib/notifications";
import { placeOrder } from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from "@/lib/providers/payment";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
const shopper: SessionUser = { id: "", email: "shopper@example.com", role: "customer" };
const stranger: SessionUser = { id: "", email: "stranger@example.com", role: "customer" };

const address = {
  recipientName: "A Shopper",
  phone: "+8801700000000",
  addressLine1: "12 Example Road",
  city: "Dhaka",
  district: "Dhaka",
};

beforeAll(async () => {
  harness = await createTestDatabase();
  setBackgroundDeliveryForTesting(false);
}, 60_000);

afterAll(async () => {
  setBackgroundDeliveryForTesting(true);
  setPaymentProviderForTesting(undefined);
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  setPaymentProviderForTesting(new MockPaymentProvider());

  const rows = await harness.db
    .insert(users)
    .values([
      { email: staff.email, passwordHash: "x", role: "staff_admin" },
      { email: shopper.email, passwordHash: "x", role: "customer" },
      { email: stranger.email, passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  staff.id = rows.find((r) => r.email === staff.email)!.id;
  shopper.id = rows.find((r) => r.email === shopper.email)!.id;
  stranger.id = rows.find((r) => r.email === stranger.email)!.id;
});

async function makeVariant(stockQuantity = 10) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await createCategory(staff, { name: `Cat ${suffix}`, slug: `cat-${suffix}` });
  const product = await createProduct(staff, {
    title: `Product ${suffix}`,
    categoryId: category.id,
    status: "in_stock",
  });
  const [variant] = await harness.db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `SKU-${suffix}`,
      priceBdt: 500_00,
      fulfillmentMode: "in_stock",
      stockQuantity,
    })
    .returning();
  return { product, variant };
}

describe("wishlist", () => {
  it("needs an account", async () => {
    const { variant } = await makeVariant();
    await expect(addToWishlist(null, variant.id)).rejects.toMatchObject({ status: 401 });
  });

  it("saves once, reads the live price, and removes only the owner's row", async () => {
    const { variant } = await makeVariant();
    await addToWishlist(shopper, variant.id);
    await addToWishlist(shopper, variant.id);
    await addToWishlist(stranger, variant.id);

    const list = await listWishlist(shopper.id);
    expect(list).toHaveLength(1);
    expect(list[0].priceBdt).toBe(500_00);

    // A price change shows up: the list stores no price of its own.
    await harness.db
      .update(productVariants)
      .set({ priceBdt: 450_00 })
      .where(eq(productVariants.id, variant.id));
    expect((await listWishlist(shopper.id))[0].priceBdt).toBe(450_00);

    await removeFromWishlist(shopper, variant.id);
    expect(await listWishlist(shopper.id)).toHaveLength(0);
    expect(await listSavedVariantIds(stranger.id, [variant.id])).toEqual([variant.id]);
  });

  it("flags a saved item that has run out", async () => {
    const { variant } = await makeVariant(0);
    await addToWishlist(shopper, variant.id);
    expect((await listWishlist(shopper.id))[0].problem).toBe("Out of stock.");
  });

  it("moves a cart line to the list and back", async () => {
    const { variant } = await makeVariant();
    const cartId = await getOrCreateCart({ userId: shopper.id });
    await addToCart(cartId, variant.id, 2);
    const [line] = await harness.db.select().from(cartItems).where(eq(cartItems.cartId, cartId));

    await saveCartItemForLater(shopper, cartId, line.id);
    expect(await harness.db.select().from(cartItems)).toHaveLength(0);
    expect(await listSavedVariantIds(shopper.id, [variant.id])).toEqual([variant.id]);

    await moveWishlistItemToCart(shopper, cartId, variant.id);
    expect(await harness.db.select().from(wishlistItems)).toHaveLength(0);
    const [back] = await harness.db.select().from(cartItems);
    expect(back.quantity).toBe(1);
  });

  it("cannot save a line out of someone else's cart", async () => {
    const { variant } = await makeVariant();
    const theirCart = await getOrCreateCart({ userId: stranger.id });
    await addToCart(theirCart, variant.id, 1);
    const [line] = await harness.db.select().from(cartItems);

    const myCart = await getOrCreateCart({ userId: shopper.id });
    await saveCartItemForLater(shopper, myCart, line.id);

    expect(await harness.db.select().from(cartItems)).toHaveLength(1);
    expect(await listWishlist(shopper.id)).toHaveLength(0);
  });

  it("keeps an item saved when the cart refuses it", async () => {
    const { variant } = await makeVariant(0);
    await addToWishlist(shopper, variant.id);
    const cartId = await getOrCreateCart({ userId: shopper.id });
    await expect(moveWishlistItemToCart(shopper, cartId, variant.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(await listWishlist(shopper.id)).toHaveLength(1);
  });
});

describe("address book", () => {
  it("makes the first address the default and moves the default on request", async () => {
    const first = await createAddress(shopper, address);
    const second = await createAddress(shopper, { ...address, addressLine1: "2 Other Road" });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    await setDefaultAddress(shopper, second.id);
    const book = await listAddresses(shopper.id);
    expect(book[0].id).toBe(second.id);
    expect(book.filter((row) => row.isDefault)).toHaveLength(1);
  });

  it("refuses another account's address as not found", async () => {
    const mine = await createAddress(shopper, address);
    await expect(updateAddress(stranger, mine.id, address)).rejects.toMatchObject({ status: 404 });
    await expect(removeAddress(stranger, mine.id)).rejects.toMatchObject({ status: 404 });
    await expect(setDefaultAddress(stranger, mine.id)).rejects.toMatchObject({ status: 404 });
  });

  it("edits an unused address in place and deletes it outright", async () => {
    const row = await createAddress(shopper, address);
    const updated = await updateAddress(shopper, row.id, { ...address, city: "Chattogram" });
    expect(updated.id).toBe(row.id);
    expect(updated.city).toBe("Chattogram");

    await removeAddress(shopper, row.id);
    expect(await harness.db.select().from(addresses)).toHaveLength(0);
  });

  it("never rewrites or deletes an address a past order used", async () => {
    const row = await createAddress(shopper, address);
    const { variant } = await makeVariant();
    const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
    await addToCart(cartId, variant.id, 1);
    const placed = await placeOrder({
      cartId,
      userId: shopper.id,
      guestEmail: shopper.email,
      guestPhone: null,
      shippingAddressId: row.id,
      method: "bkash",
      idempotencyKey: crypto.randomUUID(),
    });

    const edited = await updateAddress(shopper, row.id, { ...address, city: "Sylhet" });
    expect(edited.id).not.toBe(row.id);

    const [order] = await harness.db.select().from(orders).where(eq(orders.id, placed.orderId));
    const [original] = await harness.db
      .select()
      .from(addresses)
      .where(eq(addresses.id, order.shippingAddressId));
    expect(original.city).toBe("Dhaka");
    expect(original.userId).toBeNull();

    const book = await listAddresses(shopper.id);
    expect(book.map((entry) => entry.id)).toEqual([edited.id]);
    expect(book[0].isDefault).toBe(true);
  });
});

describe("newsletter", () => {
  it("is idempotent by address and re-subscribes after an unsubscribe", async () => {
    await subscribeToNewsletter("Someone@Example.com");
    await subscribeToNewsletter("someone@example.com");
    const rows = await harness.db.select().from(newsletterSubscribers);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("someone@example.com");

    await harness.db.update(newsletterSubscribers).set({ unsubscribedAt: new Date() });
    await subscribeToNewsletter("someone@example.com");
    const [again] = await harness.db.select().from(newsletterSubscribers);
    expect(again.unsubscribedAt).toBeNull();
  });
});

describe("recently viewed cookie", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";

  it("drops anything that is not an id, and duplicates", () => {
    expect(parseRecentlyViewed(`${a},junk,${a},${b},'; drop table`)).toEqual([a, b]);
    expect(parseRecentlyViewed(undefined)).toEqual([]);
  });

  it("puts the latest first and keeps at most twelve", () => {
    let list: string[] = [];
    for (let i = 0; i < 15; i++) {
      list = pushRecentlyViewed(list, `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
    }
    expect(list).toHaveLength(12);
    expect(pushRecentlyViewed([a, b], b)).toEqual([b, a]);
  });
});
