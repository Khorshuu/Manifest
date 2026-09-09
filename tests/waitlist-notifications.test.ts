/**
 * Telling the waitlist that places have opened up.
 *
 * The policy under test is DECISIONS.md D-011: notify, do not hold. These
 * assert the parts of it that have consequences — that a message is only ever
 * written when capacity genuinely came back, that nobody is told twice, that
 * the queue is served in the order people joined it, and that the message does
 * not promise a place that is not being held.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  notifications,
  productVariants,
  users,
  waitlistEntries,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import { composeWaitlistMessage } from "@/lib/notifications";
import { openPreorder, releaseCapacityStandalone } from "@/lib/preorder";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [row] = await harness.db
    .insert(users)
    .values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = row.id;
});

/** A published preorder variant, full, with `waiting` people queued on it. */
async function fullVariantWithQueue(waiting: string[], capacity = 2) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await createCategory(staff, {
    name: `Cat ${suffix}`,
    slug: `cat-${suffix}`,
  });
  const product = await createProduct(staff, {
    title: `Product ${suffix}`,
    categoryId: category.id,
    status: "preorder_open",
  });

  const [variant] = await harness.db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `SKU-${suffix}`,
      priceBdt: 500_00,
      fulfillmentMode: "preorder",
      preorderCapacity: capacity,
      preorderReserved: capacity,
      preorderClosesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  // Inserted one at a time with distinct timestamps, so "oldest first" is a
  // real ordering rather than an accident of insertion order.
  for (const [index, email] of waiting.entries()) {
    await harness.db.insert(waitlistEntries).values({
      variantId: variant.id,
      email,
      createdAt: new Date(Date.now() - (waiting.length - index) * 60_000),
    });
  }

  return { variant, product };
}

async function waitlistMessages() {
  return harness.db
    .select({
      recipient: notifications.recipient,
      subject: notifications.subject,
      body: notifications.body,
      template: notifications.template,
    })
    .from(notifications)
    .where(eq(notifications.template, "waitlist.places_available"));
}

describe("when a place frees up", () => {
  it("tells the people waiting, oldest first", async () => {
    const { variant } = await fullVariantWithQueue([
      "first@example.com",
      "second@example.com",
      "third@example.com",
    ]);

    // One cancellation returns one place, so exactly one person hears.
    await releaseCapacityStandalone(variant.id, 1);

    const messages = await waitlistMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].recipient).toBe("first@example.com");
  });

  it("tells as many people as there are places", async () => {
    const { variant } = await fullVariantWithQueue(
      ["a@example.com", "b@example.com", "c@example.com"],
      3,
    );

    await releaseCapacityStandalone(variant.id, 2);

    const messages = await waitlistMessages();
    expect(messages.map((m) => m.recipient).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("never tells the same person twice", async () => {
    const { variant } = await fullVariantWithQueue(["one@example.com"], 3);

    await releaseCapacityStandalone(variant.id, 1);
    await releaseCapacityStandalone(variant.id, 1);

    expect(await waitlistMessages()).toHaveLength(1);
  });

  it("marks the entry notified, so it leaves the queue", async () => {
    const { variant } = await fullVariantWithQueue(["one@example.com"]);

    await releaseCapacityStandalone(variant.id, 1);

    const [entry] = await harness.db
      .select({ notifiedAt: waitlistEntries.notifiedAt })
      .from(waitlistEntries)
      .where(eq(waitlistEntries.variantId, variant.id));

    expect(entry.notifiedAt).not.toBeNull();
  });

  it("says nothing when nobody is waiting", async () => {
    const { variant } = await fullVariantWithQueue([]);

    await releaseCapacityStandalone(variant.id, 1);

    expect(await waitlistMessages()).toHaveLength(0);
  });
});

describe("when staff raise the ceiling", () => {
  it("tells the queue about the places that opened, not the size of the rise", async () => {
    // Two places spare already, ceiling raised by five: seven are buyable, so
    // five is what actually opened.
    const { variant } = await fullVariantWithQueue(
      ["a@example.com", "b@example.com", "c@example.com"],
      2,
    );

    await harness.db
      .update(productVariants)
      .set({ preorderReserved: 0 })
      .where(eq(productVariants.id, variant.id));

    // Two buyable before, seven after: five opened, but only three are waiting.
    await openPreorder(staff, variant.id, {
      capacity: 7,
      closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const messages = await waitlistMessages();
    expect(messages).toHaveLength(3);
  });

  it("says nothing when the ceiling does not move", async () => {
    const { variant } = await fullVariantWithQueue(["a@example.com"], 2);

    await openPreorder(staff, variant.id, {
      capacity: 2,
      closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    expect(await waitlistMessages()).toHaveLength(0);
  });
});

describe("what the message says", () => {
  /**
   * The whole point of D-011. Someone who reads "a place is available" as "a
   * place is yours", drops what they are doing, and finds the batch full again
   * is worse served than someone who was never written to.
   */
  it("states plainly that no place is held", async () => {
    const { variant } = await fullVariantWithQueue(["one@example.com"]);

    await releaseCapacityStandalone(variant.id, 1);

    const [message] = await waitlistMessages();
    expect(message.body).toMatch(/not held for you/i);
    expect(message.body).toMatch(/orders first/i);
  });

  it("names the product a person would recognise", async () => {
    const composed = composeWaitlistMessage({
      productTitle: "Studio Reference Headphones",
      variantLabel: "Midnight Black",
      productSlug: "studio-reference-headphones",
      places: 1,
    });

    expect(composed.subject).toContain("Studio Reference Headphones");
    expect(composed.subject).toContain("Midnight Black");
  });

  /** A product with no options should not be described by a placeholder. */
  it("does not print the internal label for a product with one variant", () => {
    const composed = composeWaitlistMessage({
      productTitle: "Cast Iron Skillet",
      variantLabel: "Single variant",
      productSlug: "cast-iron-skillet",
      places: 2,
    });

    expect(composed.subject).toBe("Cast Iron Skillet is available again");
    expect(composed.body).not.toContain("Single variant");
  });
});

describe("when there is nothing to point anyone at", () => {
  it("stays quiet if the product is no longer on sale", async () => {
    const { variant, product } = await fullVariantWithQueue(["one@example.com"]);

    await harness.db
      .update(productVariants)
      .set({ isEnabled: false })
      .where(eq(productVariants.id, variant.id));

    await releaseCapacityStandalone(variant.id, 1);

    expect(await waitlistMessages()).toHaveLength(0);
    expect(product.id).toBeTruthy();
  });
});
