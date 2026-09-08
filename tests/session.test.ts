/**
 * Session lifecycle against a real (in-process) Postgres, exercising the same
 * queries the application runs. These cover the claims made in
 * docs/SECURITY.md: the database never stores a replayable token, and a
 * revoked or expired session stops working immediately.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessions, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import {
  createSession,
  invalidateAllUserSessions,
  invalidateSession,
  validateSessionToken,
  deleteExpiredSessions,
} from "@/lib/auth/session";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let userId: string;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.delete(sessions);
  await harness.db.delete(users);

  const [user] = await harness.db
    .insert(users)
    .values({
      email: "session-test@example.com",
      passwordHash: await hashPassword("a-long-enough-password"),
      role: "staff_admin",
    })
    .returning({ id: users.id });

  userId = user.id;
}, 30_000);

describe("createSession", () => {
  it("stores a hash of the token, never the token itself", async () => {
    const { token } = await createSession(userId);

    const rows = await harness.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(token);
    // SHA-256 hex is 64 characters.
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("issues a different token each time", async () => {
    const first = await createSession(userId);
    const second = await createSession(userId);
    expect(first.token).not.toBe(second.token);
  });
});

describe("validateSessionToken", () => {
  it("resolves a valid token to its user and role", async () => {
    const { token } = await createSession(userId);
    const session = await validateSessionToken(token);

    expect(session).not.toBeNull();
    expect(session?.user.id).toBe(userId);
    expect(session?.user.email).toBe("session-test@example.com");
    expect(session?.user.role).toBe("staff_admin");
  });

  it("rejects a token that was never issued", async () => {
    await expect(validateSessionToken("made-up-token")).resolves.toBeNull();
  });

  it("rejects an expired session and cleans the row up", async () => {
    const { token } = await createSession(userId);
    const rows = await harness.db.select().from(sessions);

    await harness.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, rows[0].id));

    await expect(validateSessionToken(token)).resolves.toBeNull();
    await expect(harness.db.select().from(sessions)).resolves.toHaveLength(0);
  });

  /**
   * The reason sessions are read from the database on every request rather
   * than trusted from a signed token: a role change must take effect at once.
   */
  it("reflects a role change immediately", async () => {
    const { token } = await createSession(userId);

    await harness.db
      .update(users)
      .set({ role: "customer" })
      .where(eq(users.id, userId));

    const session = await validateSessionToken(token);
    expect(session?.user.role).toBe("customer");
  });
});

describe("invalidation", () => {
  it("invalidateSession ends only that session", async () => {
    const first = await createSession(userId);
    const second = await createSession(userId);

    await invalidateSession(first.token);

    await expect(validateSessionToken(first.token)).resolves.toBeNull();
    await expect(validateSessionToken(second.token)).resolves.not.toBeNull();
  });

  it("invalidateAllUserSessions signs the user out everywhere", async () => {
    const first = await createSession(userId);
    const second = await createSession(userId);

    await invalidateAllUserSessions(userId);

    await expect(validateSessionToken(first.token)).resolves.toBeNull();
    await expect(validateSessionToken(second.token)).resolves.toBeNull();
  });

  it("deleteExpiredSessions removes only expired rows", async () => {
    // Expire everything that exists, then issue a live session, so which row
    // is which is known rather than inferred.
    const stale = await createSession(userId);
    await harness.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) });

    const live = await createSession(userId);

    await deleteExpiredSessions();

    const remaining = await harness.db.select().from(sessions);
    expect(remaining).toHaveLength(1);
    await expect(validateSessionToken(stale.token)).resolves.toBeNull();
    await expect(validateSessionToken(live.token)).resolves.not.toBeNull();
  });
});
