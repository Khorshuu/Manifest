/**
 * Reviews.
 *
 * The two rules that decide whether reviews are worth anything: only a
 * delivered order lets someone write one, and nothing is public until a human
 * approves it. Both are enforced server-side, so a page that renders the form
 * by mistake still cannot produce a review.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addresses, auditLog, productVariants, reviews, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { addToCart, getOrCreateCart, newCartToken } from "@/lib/cart";
import { createCategory, createProduct, getProductRating } from "@/lib/catalog";
import { setBackgroundDeliveryForTesting } from "@/lib/notifications";
import { advanceOrder, confirmPayment, placeOrder } from "@/lib/orders";
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from "@/lib/providers/payment";
import {
  countPendingReviews,
  getRatingBreakdown,
  hasReviewed,
  listApprovedReviews,
  listReviewableProducts,
  listReviewsForModeration,
  moderateReview,
  ReviewError,
  submitReview,
} from "@/lib/reviews";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const shopper: SessionUser = {
  id: "",
  email: "hasnain.shopper@example.com",
  role: "customer",
};
const stranger: SessionUser = {
  id: "",
  email: "stranger@example.com",
  role: "customer",
};

let addressId = "";

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
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      {
        email: "hasnain.shopper@example.com",
        passwordHash: "x",
        role: "customer",
      },
      { email: "stranger@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  staff.id = rows.find((r) => r.email === "staff@example.com")!.id;
  shopper.id = rows.find((r) => r.email === shopper.email)!.id;
  stranger.id = rows.find((r) => r.email === "stranger@example.com")!.id;

  const [address] = await harness.db
    .insert(addresses)
    .values({
      userId: shopper.id,
      recipientName: "A Shopper",
      phone: "+8801700000000",
      addressLine1: "12 Example Road",
      city: "Dhaka",
      district: "Dhaka",
    })
    .returning({ id: addresses.id });

  addressId = address.id;
});

/**
 * Buys a product as the shopper and walks it to `deliverThrough`, so the
 * eligibility rule is exercised through the real order pipeline rather than by
 * writing a status straight into the table.
 */
async function buyProduct(deliverThrough: boolean) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await createCategory(staff, {
    name: `Cat ${suffix}`,
    slug: `cat-${suffix}`,
  });
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
      stockQuantity: 10,
    })
    .returning();

  const cartId = await getOrCreateCart({ sessionToken: newCartToken() });
  await addToCart(cartId, variant.id, 1);

  const placed = await placeOrder({
    cartId,
    userId: shopper.id,
    guestEmail: shopper.email,
    guestPhone: null,
    shippingAddressId: addressId,
    method: "bkash",
    idempotencyKey: `key-${suffix}`,
  });

  if (deliverThrough) {
    const payment = await harness.db.query.payments.findFirst();
    await confirmPayment(payment!.providerRef!);

    for (const status of [
      "sourcing",
      "shipped_from_us",
      "in_bd_customs",
      "out_for_delivery",
      "delivered",
    ] as const) {
      await advanceOrder(staff, placed.orderId, status);
    }
  }

  return { productId: product.id, orderId: placed.orderId };
}

describe("who may write a review", () => {
  it("refuses someone who never bought the product", async () => {
    const { productId } = await buyProduct(true);

    await expect(
      submitReview(stranger, { productId, rating: 5 }),
    ).rejects.toThrow(ReviewError);
  });

  it("refuses an anonymous visitor", async () => {
    const { productId } = await buyProduct(true);

    await expect(submitReview(null, { productId, rating: 5 })).rejects.toThrow(
      /Sign in/,
    );
  });

  /** An order still in transit has not been seen by anyone. */
  it("refuses a buyer whose order has not been delivered", async () => {
    const { productId } = await buyProduct(false);

    await expect(
      submitReview(shopper, { productId, rating: 5 }),
    ).rejects.toThrow(/received this product/);
  });

  it("accepts a buyer whose order was delivered", async () => {
    const { productId } = await buyProduct(true);

    const review = await submitReview(shopper, {
      productId,
      rating: 4,
      title: "Arrived sealed",
      body: "Exactly what was described.",
    });

    expect(review.rating).toBe(4);
    expect(review.status).toBe("pending");
  });

  it("allows one review per product per person", async () => {
    const { productId } = await buyProduct(true);
    await submitReview(shopper, { productId, rating: 5 });

    await expect(
      submitReview(shopper, { productId, rating: 1 }),
    ).rejects.toThrow(/already reviewed/);
  });

  it("refuses a rating outside 1 to 5", async () => {
    const { productId } = await buyProduct(true);

    await expect(
      submitReview(shopper, { productId, rating: 6 }),
    ).rejects.toThrow(ReviewError);
    await expect(
      submitReview(shopper, { productId, rating: 0 }),
    ).rejects.toThrow(ReviewError);
  });
});

describe("what the public sees", () => {
  it("hides a review until it is approved", async () => {
    const { productId } = await buyProduct(true);
    await submitReview(shopper, { productId, rating: 5, body: "Excellent" });

    expect(await listApprovedReviews(productId)).toHaveLength(0);
    // And it does not move the average either.
    expect((await getProductRating(productId)).count).toBe(0);
  });

  it("shows it once approved, and counts it in the average", async () => {
    const { productId } = await buyProduct(true);
    const review = await submitReview(shopper, { productId, rating: 5 });

    await moderateReview(staff, review.id, "approved");

    const published = await listApprovedReviews(productId);
    expect(published).toHaveLength(1);

    const rating = await getProductRating(productId);
    expect(rating.count).toBe(1);
    expect(rating.average).toBe(5);
  });

  it("removes it again when it is rejected", async () => {
    const { productId } = await buyProduct(true);
    const review = await submitReview(shopper, { productId, rating: 5 });

    await moderateReview(staff, review.id, "approved");
    await moderateReview(staff, review.id, "rejected");

    expect(await listApprovedReviews(productId)).toHaveLength(0);
    expect((await getProductRating(productId)).count).toBe(0);
  });

  /** A review shows a name, never the address someone signed up with. */
  it("never publishes the reviewer's email address", async () => {
    const { productId } = await buyProduct(true);
    const review = await submitReview(shopper, { productId, rating: 5 });
    await moderateReview(staff, review.id, "approved");

    const [published] = await listApprovedReviews(productId);

    expect(published.authorName).toBe("Hasnain");
    expect(JSON.stringify(published)).not.toContain("@example.com");
  });

  it("reports the spread of ratings from real rows", async () => {
    const { productId } = await buyProduct(true);
    const review = await submitReview(shopper, { productId, rating: 4 });
    await moderateReview(staff, review.id, "approved");

    const breakdown = await getRatingBreakdown(productId);

    expect(breakdown[4]).toBe(1);
    expect(breakdown[5]).toBe(0);
  });
});

describe("moderation", () => {
  it("refuses a customer", async () => {
    const { productId } = await buyProduct(true);
    const review = await submitReview(shopper, { productId, rating: 5 });

    await expect(listReviewsForModeration(shopper)).rejects.toThrow(
      AuthorizationError,
    );
    await expect(
      moderateReview(shopper, review.id, "approved"),
    ).rejects.toThrow(AuthorizationError);
    await expect(countPendingReviews(shopper)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("lists the queue with the product and the author", async () => {
    const { productId } = await buyProduct(true);
    await submitReview(shopper, { productId, rating: 3, title: "Fine" });

    const queue = await listReviewsForModeration(staff, { status: "pending" });

    expect(queue).toHaveLength(1);
    expect(queue[0].authorEmail).toBe(shopper.email);
    expect(queue[0].productTitle).toMatch(/^Product /);
  });

  it("counts what is waiting", async () => {
    const { productId } = await buyProduct(true);
    expect(await countPendingReviews(staff)).toBe(0);

    const review = await submitReview(shopper, { productId, rating: 5 });
    expect(await countPendingReviews(staff)).toBe(1);

    await moderateReview(staff, review.id, "approved");
    expect(await countPendingReviews(staff)).toBe(0);
  });

  /** A review disappearing from a product page has to be explainable. */
  it("audits the decision with the status it replaced", async () => {
    const { productId } = await buyProduct(true);
    const review = await submitReview(shopper, { productId, rating: 2 });

    await moderateReview(staff, review.id, "rejected");

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, review.id));

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("review.moderated");
    expect(entries[0].beforeJson).toEqual({ status: "pending" });
    expect(entries[0].afterJson).toEqual({ status: "rejected" });
  });

  it("refuses a review that does not exist", async () => {
    await expect(
      moderateReview(staff, "00000000-0000-0000-0000-000000000000", "approved"),
    ).rejects.toThrow(ReviewError);
  });
});

describe("what a customer is invited to review", () => {
  it("offers a delivered product", async () => {
    const { productId } = await buyProduct(true);

    const reviewable = await listReviewableProducts(shopper);
    expect(reviewable.map((row) => row.productId)).toContain(productId);
  });

  it("does not offer one still in transit", async () => {
    await buyProduct(false);
    expect(await listReviewableProducts(shopper)).toHaveLength(0);
  });

  it("stops offering it once reviewed", async () => {
    const { productId } = await buyProduct(true);
    await submitReview(shopper, { productId, rating: 5 });

    expect(await listReviewableProducts(shopper)).toHaveLength(0);
    expect(await hasReviewed(shopper.id, productId)).toBe(true);
  });

  it("offers nothing to an anonymous visitor", async () => {
    await buyProduct(true);
    expect(await listReviewableProducts(null)).toHaveLength(0);
  });
});

describe("the stored row", () => {
  it("records which order item entitled the review", async () => {
    const { productId } = await buyProduct(true);
    const review = await submitReview(shopper, { productId, rating: 5 });

    const [row] = await harness.db
      .select()
      .from(reviews)
      .where(eq(reviews.id, review.id));

    // Verified purchase is a join, not a flag someone sets.
    expect(row.orderItemId).not.toBeNull();
  });
});
