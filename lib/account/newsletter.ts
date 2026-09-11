import { eq } from "drizzle-orm";
import { db } from "@/db";
import { newsletterSubscribers } from "@/db/schema";

/**
 * Newsletter signup.
 *
 * Idempotent by address: signing up again is not an error and does not reveal
 * whether the address was already on the list, so the form cannot be used to
 * test which emails are customers. A re-subscribe clears an earlier
 * unsubscribe.
 */
export async function subscribeToNewsletter(
  email: string,
  options: { userId?: string | null; source?: string } = {},
): Promise<void> {
  await db
    .insert(newsletterSubscribers)
    .values({
      email: email.trim().toLowerCase(),
      userId: options.userId ?? null,
      source: options.source ?? "footer",
    })
    .onConflictDoUpdate({
      target: newsletterSubscribers.email,
      set: { unsubscribedAt: null },
    });
}

export async function unsubscribeFromNewsletter(email: string): Promise<void> {
  await db
    .update(newsletterSubscribers)
    .set({ unsubscribedAt: new Date() })
    .where(eq(newsletterSubscribers.email, email.trim().toLowerCase()));
}
