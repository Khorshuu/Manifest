import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users, type UserRole } from "@/db/schema";

export const SESSION_COOKIE_NAME = "session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30;

export type SessionUser = {
  id: string;
  email: string;
  role: UserRole;
};

export type Session = {
  id: string;
  expiresAt: Date;
  user: SessionUser;
};

/**
 * The cookie carries a random token; the database stores only its SHA-256.
 * A leaked database backup therefore cannot be replayed as a live session.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A pending session is short-lived: it exists only to be upgraded. */
const PENDING_SESSION_DURATION_MS = 1000 * 60 * 10;

export async function createSession(
  userId: string,
  options: { pendingTwoFactor?: boolean } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const pending = options.pendingTwoFactor ?? false;
  const expiresAt = new Date(
    Date.now() + (pending ? PENDING_SESSION_DURATION_MS : SESSION_DURATION_MS),
  );

  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt,
    pendingTwoFactor: pending,
  });

  return { token, expiresAt };
}

/**
 * Turns a session that has passed the password into a full one, once the
 * second factor is proved. The row is reused rather than replaced so nothing
 * else has to learn a new token, and its lifetime extends to the normal one.
 */
export async function upgradePendingSession(
  token: string,
): Promise<{ expiresAt: Date } | null> {
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  const rows = await db
    .update(sessions)
    .set({ pendingTwoFactor: false, expiresAt })
    .where(
      and(
        eq(sessions.id, hashToken(token)),
        eq(sessions.pendingTwoFactor, true),
      ),
    )
    .returning({ id: sessions.id });

  return rows.length > 0 ? { expiresAt } : null;
}

/**
 * The user behind a session that has not yet cleared its second factor. Used
 * only by the endpoint that checks that factor — it deliberately does not
 * return a `SessionUser`, so it cannot be mistaken for an authenticated one.
 */
export async function pendingSessionUserId(
  token: string,
): Promise<string | null> {
  const rows = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, hashToken(token)),
        eq(sessions.pendingTwoFactor, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return row.userId;
}

/**
 * Resolves a cookie token to its session and user, or null. Every request
 * re-reads the row, so revoking a session or changing a role takes effect
 * immediately rather than waiting for a token to expire (see SECURITY.md).
 */
export async function validateSessionToken(
  token: string,
): Promise<Session | null> {
  const sessionId = hashToken(token);

  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      pendingTwoFactor: sessions.pendingTwoFactor,
      userId: users.id,
      email: users.email,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // A session waiting on its second factor authenticates nothing at all: this
  // is the single check that keeps a half-finished sign-in out of every page
  // and endpoint, rather than each of them remembering to look.
  if (row.pendingTwoFactor) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }

  return {
    id: row.sessionId,
    expiresAt: row.expiresAt,
    user: {
      id: row.userId,
      email: row.email,
      role: row.role as UserRole,
    },
  };
}

export async function invalidateSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Logout everywhere: drops every session belonging to a user. */
export async function invalidateAllUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function deleteExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

/** Constant-time comparison, for any place a token is compared directly. */
export function safeTokenEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;
