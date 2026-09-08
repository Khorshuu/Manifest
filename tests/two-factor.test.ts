/**
 * Two-factor authentication.
 *
 * The rules with teeth: a secret does not take effect until someone proves
 * they can produce a code from it, a password alone buys a session that
 * authenticates nothing, a code cannot be used twice, and a recovery code is
 * spent the first time it works.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, recoveryCodes, sessions, users } from "@/db/schema";
import { authenticate } from "@/lib/auth/accounts";
import { hashPassword } from "@/lib/auth/password";
import {
  createSession,
  pendingSessionUserId,
  upgradePendingSession,
  validateSessionToken,
} from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/session";
import { totp, totpStep } from "@/lib/auth/totp";
import {
  beginEnrollment,
  confirmEnrollment,
  consumeRecoveryCode,
  disableTwoFactor,
  getTwoFactorStatus,
  requiresTwoFactor,
  TwoFactorError,
  verifySecondFactor,
} from "@/lib/auth/two-factor";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const admin: SessionUser = {
  id: "",
  email: "admin@example.com",
  role: "super_admin",
};
const other: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};

const PASSWORD = "correct horse battery staple";

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();

  const hash = await hashPassword(PASSWORD);

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "admin@example.com", passwordHash: hash, role: "super_admin" },
      { email: "staff@example.com", passwordHash: hash, role: "staff_admin" },
    ])
    .returning({ id: users.id, email: users.email });

  admin.id = rows.find((r) => r.email === "admin@example.com")!.id;
  other.id = rows.find((r) => r.email === "staff@example.com")!.id;
});

/**
 * A code from the next step. Confirming enrolment spends the current step, so
 * a test that wants another valid code has to move on — the same thing a real
 * person does by waiting for the next one to appear.
 */
function nextCode(secret: string): string {
  return totp(secret, Date.now() + 30_000);
}

/** Enrols the account and returns its secret and recovery codes. */
async function enrol(actor: SessionUser) {
  const { secret } = await beginEnrollment(actor);
  const { recoveryCodes: codes } = await confirmEnrollment(
    actor,
    totp(secret),
  );
  return { secret, codes };
}

describe("enrolling", () => {
  it("does not take effect until a code proves the secret works", async () => {
    await beginEnrollment(admin);

    // Scanned but never confirmed: signing in must not start asking for codes.
    expect(await requiresTwoFactor(admin.id)).toBe(false);

    const status = await getTwoFactorStatus(admin);
    expect(status.enrolling).toBe(true);
    expect(status.enabled).toBe(false);
  });

  it("turns on once a correct code is given", async () => {
    const { secret } = await beginEnrollment(admin);
    await confirmEnrollment(admin, totp(secret));

    expect(await requiresTwoFactor(admin.id)).toBe(true);
    expect((await getTwoFactorStatus(admin)).enabled).toBe(true);
  });

  it("refuses a wrong code and stays off", async () => {
    await beginEnrollment(admin);

    await expect(confirmEnrollment(admin, "000000")).rejects.toThrow(
      TwoFactorError,
    );
    expect(await requiresTwoFactor(admin.id)).toBe(false);
  });

  it("gives ten recovery codes, once", async () => {
    const { codes } = await enrol(admin);

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    // Stored hashed: nothing can read them back, including this test.
    const stored = await harness.db
      .select()
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, admin.id));

    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(codes).not.toContain(row.codeHash);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("lets an abandoned enrolment be restarted", async () => {
    const first = await beginEnrollment(admin);
    const second = await beginEnrollment(admin);

    expect(second.secret).not.toBe(first.secret);
    // The old secret is dead; only the newest one confirms.
    await expect(confirmEnrollment(admin, totp(first.secret))).rejects.toThrow();
    await confirmEnrollment(admin, totp(second.secret));

    expect(await requiresTwoFactor(admin.id)).toBe(true);
  });

  /** Otherwise a borrowed session could quietly swap in its own device. */
  it("refuses to re-enrol an account that already has it on", async () => {
    await enrol(admin);
    await expect(beginEnrollment(admin)).rejects.toThrow(/already on/i);
  });

  it("refuses an anonymous caller", async () => {
    await expect(beginEnrollment(null)).rejects.toThrow(TwoFactorError);
    await expect(confirmEnrollment(null, "123456")).rejects.toThrow(
      TwoFactorError,
    );
  });

  it("records the change in the audit log", async () => {
    await enrol(admin);

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, admin.id));

    expect(entries.map((entry) => entry.action)).toContain(
      "user.two_factor_enabled",
    );
  });
});

describe("signing in", () => {
  it("gives a full session when no second factor is configured", async () => {
    const result = await authenticate({
      email: admin.email,
      password: PASSWORD,
    });

    expect(result.needsSecondFactor).toBe(false);
    expect(await validateSessionToken(result.session.token)).not.toBeNull();
  });

  /** The point of the whole feature: the password alone is not enough. */
  it("gives a session that authenticates nothing when a code is owed", async () => {
    await enrol(admin);

    const result = await authenticate({
      email: admin.email,
      password: PASSWORD,
    });

    expect(result.needsSecondFactor).toBe(true);
    expect(await validateSessionToken(result.session.token)).toBeNull();
    expect(await pendingSessionUserId(result.session.token)).toBe(admin.id);
  });

  it("becomes a real session once the code is proved", async () => {
    const { secret } = await enrol(admin);

    const result = await authenticate({
      email: admin.email,
      password: PASSWORD,
    });

    const verified = await verifySecondFactor(admin.id, nextCode(secret));
    expect(verified.accepted).toBe(true);

    await upgradePendingSession(result.session.token);

    const session = await validateSessionToken(result.session.token);
    expect(session?.user.id).toBe(admin.id);
  });

  it("refuses a wrong code and leaves the session pending", async () => {
    await enrol(admin);

    const result = await authenticate({
      email: admin.email,
      password: PASSWORD,
    });

    expect((await verifySecondFactor(admin.id, "000000")).accepted).toBe(false);
    expect(await validateSessionToken(result.session.token)).toBeNull();
  });

  /** A code seen over a shoulder must not work a second time. */
  it("refuses a code that has already been used", async () => {
    const { secret } = await enrol(admin);
    const code = nextCode(secret);

    expect((await verifySecondFactor(admin.id, code)).accepted).toBe(true);
    expect((await verifySecondFactor(admin.id, code)).accepted).toBe(false);
  });

  it("records which step was spent", async () => {
    const { secret } = await enrol(admin);
    await verifySecondFactor(admin.id, nextCode(secret));

    const [row] = await harness.db
      .select({ step: users.totpLastUsedStep })
      .from(users)
      .where(eq(users.id, admin.id));

    // The code came from the next step, and that is the step recorded.
    expect(row.step).toBe(totpStep(Date.now() + 30_000));
  });

  it("refuses a code belonging to a different account", async () => {
    const { secret } = await enrol(admin);
    await enrol(other);

    expect((await verifySecondFactor(other.id, totp(secret))).accepted).toBe(
      false,
    );
  });

  it("refuses everything for an account with it switched off", async () => {
    expect((await verifySecondFactor(admin.id, "123456")).accepted).toBe(false);
  });

  it("cannot upgrade a session that was never pending", async () => {
    const session = await createSession(admin.id);
    expect(await upgradePendingSession(session.token)).toBeNull();
  });

  it("cannot upgrade with a token that is not a session at all", async () => {
    expect(await upgradePendingSession("not-a-real-token")).toBeNull();
  });

  it("expires a pending session quickly", async () => {
    const session = await createSession(admin.id, { pendingTwoFactor: true });

    // Ten minutes, not thirty days: an abandoned half sign-in should not sit
    // there waiting to be finished.
    const [row] = await harness.db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, admin.id));

    const minutes = (row.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(5);
    expect(minutes).toBeLessThanOrEqual(10);
    expect(session.token).toBeTruthy();
  });
});

describe("recovery codes", () => {
  it("gets someone in when the phone is gone", async () => {
    const { codes } = await enrol(admin);

    const result = await verifySecondFactor(admin.id, codes[0]);
    expect(result.accepted).toBe(true);
    expect(result.usedRecoveryCode).toBe(true);
  });

  it("spends the code, so it works exactly once", async () => {
    const { codes } = await enrol(admin);

    expect((await verifySecondFactor(admin.id, codes[0])).accepted).toBe(true);
    expect((await verifySecondFactor(admin.id, codes[0])).accepted).toBe(false);
    // The others still work.
    expect((await verifySecondFactor(admin.id, codes[1])).accepted).toBe(true);
  });

  it("accepts one written back without its dash, or in lower case", async () => {
    const { codes } = await enrol(admin);
    const typed = codes[0].replace("-", "").toLowerCase();

    expect((await verifySecondFactor(admin.id, typed)).accepted).toBe(true);
  });

  it("refuses one belonging to a different account", async () => {
    const { codes } = await enrol(admin);
    await enrol(other);

    expect(await consumeRecoveryCode(other.id, codes[0])).toBe(false);
    // And it is still unspent for the account it belongs to.
    expect(await consumeRecoveryCode(admin.id, codes[0])).toBe(true);
  });

  it("refuses an empty or invented code", async () => {
    await enrol(admin);

    expect(await consumeRecoveryCode(admin.id, "")).toBe(false);
    expect(await consumeRecoveryCode(admin.id, "AAAAAAAA-BBBBBBBB")).toBe(false);
  });

  it("counts down what is left", async () => {
    const { codes } = await enrol(admin);
    expect((await getTwoFactorStatus(admin)).remainingRecoveryCodes).toBe(10);

    await verifySecondFactor(admin.id, codes[0]);
    expect((await getTwoFactorStatus(admin)).remainingRecoveryCodes).toBe(9);
  });
});

describe("turning it off", () => {
  it("needs a current code, not just a live session", async () => {
    await enrol(admin);

    await expect(disableTwoFactor(admin, "000000")).rejects.toThrow(
      TwoFactorError,
    );
    expect(await requiresTwoFactor(admin.id)).toBe(true);
  });

  it("turns off with a code and forgets the secret and the recovery codes", async () => {
    const { secret } = await enrol(admin);
    await disableTwoFactor(admin, nextCode(secret));

    expect(await requiresTwoFactor(admin.id)).toBe(false);

    const [row] = await harness.db
      .select({ secret: users.totpSecret })
      .from(users)
      .where(eq(users.id, admin.id));
    expect(row.secret).toBeNull();

    const remaining = await harness.db
      .select()
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, admin.id));
    expect(remaining).toHaveLength(0);
  });

  it("also accepts a recovery code, for the lost-phone case", async () => {
    const { codes } = await enrol(admin);
    await disableTwoFactor(admin, codes[0]);

    expect(await requiresTwoFactor(admin.id)).toBe(false);
  });

  it("refuses when it was never on", async () => {
    await expect(disableTwoFactor(admin, "123456")).rejects.toThrow(/not on/i);
  });

  it("records the change in the audit log", async () => {
    const { secret } = await enrol(admin);
    await disableTwoFactor(admin, nextCode(secret));

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, admin.id));

    expect(entries.map((entry) => entry.action)).toContain(
      "user.two_factor_disabled",
    );
  });
});
