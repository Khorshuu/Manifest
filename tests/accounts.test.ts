/**
 * Account creation and sign-in against a real (in-process) Postgres. The
 * assertions here are the security rules from docs/SECURITY.md: identical
 * failure messages, no client-chosen role, and no plaintext at rest.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessions, users } from "@/db/schema";
import {
  authenticate,
  CredentialsError,
  EmailTakenError,
  register,
} from "@/lib/auth/accounts";
import { validateSessionToken } from "@/lib/auth/session";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  // Sessions reference users, so they go first.
  await harness.db.delete(sessions);
  await harness.db.delete(users);
});

const credentials = {
  email: "shopper@example.com",
  password: "a-long-enough-password",
};

describe("register", () => {
  it("creates a customer and signs them straight in", async () => {
    const { user, session } = await register(credentials);

    expect(user.role).toBe("customer");

    const resolved = await validateSessionToken(session.token);
    expect(resolved?.user.id).toBe(user.id);
  }, 30_000);

  /**
   * Self-registration can only ever produce a customer. Staff accounts are
   * created by a super_admin — the business model statement in
   * MASTER_PRODUCT_SPEC.md depends on this.
   */
  it("always produces a customer, whatever the caller sends", async () => {
    await register({
      ...credentials,
      ...({ role: "super_admin" } as Record<string, unknown>),
    });

    const [created] = await harness.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.email, credentials.email));

    expect(created.role).toBe("customer");
  }, 30_000);

  it("never stores the password in the clear", async () => {
    await register(credentials);

    const [created] = await harness.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, credentials.email));

    expect(created.passwordHash).not.toContain(credentials.password);
    expect(created.passwordHash?.startsWith("$argon2id$")).toBe(true);
  }, 30_000);

  it("refuses a second account on the same email", async () => {
    await register(credentials);
    await expect(register(credentials)).rejects.toThrow(EmailTakenError);
  }, 30_000);
});

describe("authenticate", () => {
  it("signs in with the right password", async () => {
    await register(credentials);
    const { user, session } = await authenticate(credentials);

    expect(user.email).toBe(credentials.email);
    await expect(validateSessionToken(session.token)).resolves.not.toBeNull();
  }, 30_000);

  it("refuses the wrong password", async () => {
    await register(credentials);
    await expect(
      authenticate({ email: credentials.email, password: "wrong" }),
    ).rejects.toThrow(CredentialsError);
  }, 30_000);

  /**
   * An unknown email and a wrong password must be indistinguishable, so the
   * response cannot be used to discover which accounts exist.
   */
  it("gives an unknown account the same error as a wrong password", async () => {
    await register(credentials);

    const unknown = await authenticate({
      email: "nobody@example.com",
      password: "whatever",
    }).catch((error) => error);
    const wrong = await authenticate({
      email: credentials.email,
      password: "wrong",
    }).catch((error) => error);

    expect(unknown).toBeInstanceOf(CredentialsError);
    expect(wrong).toBeInstanceOf(CredentialsError);
    expect(unknown.message).toBe(wrong.message);
  }, 30_000);

  it("does not create a session on a failed attempt", async () => {
    await register(credentials);
    await authenticate({ email: credentials.email, password: "wrong" }).catch(
      () => undefined,
    );

    const sessionRows = await harness.client.query<{ count: string }>(
      `select count(*)::text as count from sessions`,
    );
    // Only the one created by register above.
    expect(sessionRows.rows[0].count).toBe("1");
  }, 30_000);
});
