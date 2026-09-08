import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recoveryCodes, users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import type { SessionUser } from "./session";
import {
  generateTotpSecret,
  totpAuthUri,
  verifyTotp,
  type TotpVerification,
} from "./totp";

/**
 * Two-factor authentication for the people who can change prices, refund
 * money, and read every customer's address.
 *
 * The shape of it: a secret is generated and stored unconfirmed, and only
 * becomes live once the person proves they can produce a code from it. That
 * ordering matters — enabling on generation would lock someone out of their
 * own account if the QR code never scanned properly.
 */

export class TwoFactorError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "TwoFactorError";
  }
}

const RECOVERY_CODE_COUNT = 10;

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");
}

/** Case and dashes are how it is written down, not part of the secret. */
function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Readable in two halves, which is how people copy them onto paper. */
function newRecoveryCode(): string {
  const raw = randomBytes(8).toString("hex").toUpperCase();
  return `${raw.slice(0, 8)}-${raw.slice(8)}`;
}

export type Enrollment = {
  secret: string;
  /** For the QR code an authenticator app scans. */
  uri: string;
};

/**
 * Starts enrolment. Overwrites any unconfirmed secret, so abandoning a first
 * attempt and starting again works; refuses to touch a confirmed one, so an
 * attacker with a live session cannot quietly re-enrol their own device.
 */
export async function beginEnrollment(
  actor: SessionUser | null,
  issuer = "Manifest",
): Promise<Enrollment> {
  if (!actor) throw new TwoFactorError("Sign in first.");

  const [current] = await db
    .select({ confirmedAt: users.totpConfirmedAt })
    .from(users)
    .where(eq(users.id, actor.id));

  if (!current) throw new TwoFactorError("That account no longer exists.");

  if (current.confirmedAt) {
    throw new TwoFactorError(
      "Two-factor authentication is already on for this account. Turn it off first.",
    );
  }

  const secret = generateTotpSecret();

  await db
    .update(users)
    .set({ totpSecret: secret, totpLastUsedStep: null, updatedAt: new Date() })
    .where(eq(users.id, actor.id));

  return {
    secret,
    uri: totpAuthUri({ secret, account: actor.email, issuer }),
  };
}

/**
 * Confirms enrolment with a code from the app, and returns the recovery codes
 * once. They are shown once and stored hashed: if they could be read back
 * later, a live session would be enough to defeat the second factor.
 */
export async function confirmEnrollment(
  actor: SessionUser | null,
  code: string,
  now: number = Date.now(),
): Promise<{ recoveryCodes: string[] }> {
  if (!actor) throw new TwoFactorError("Sign in first.");

  const [current] = await db
    .select({
      secret: users.totpSecret,
      confirmedAt: users.totpConfirmedAt,
    })
    .from(users)
    .where(eq(users.id, actor.id));

  if (!current?.secret) {
    throw new TwoFactorError("Start setting up two-factor authentication first.");
  }

  if (current.confirmedAt) {
    throw new TwoFactorError("Two-factor authentication is already on.");
  }

  const result = verifyTotp(current.secret, code, { now });
  if (!result.valid) {
    throw new TwoFactorError("That code is not right. Try the current one.");
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        totpConfirmedAt: new Date(now),
        totpLastUsedStep: result.step,
        updatedAt: new Date(now),
      })
      .where(eq(users.id, actor.id));

    // Replaces any codes from a previous enrolment rather than adding to them.
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, actor.id));

    await tx.insert(recoveryCodes).values(
      codes.map((value) => ({
        userId: actor.id,
        codeHash: hashRecoveryCode(value),
      })),
    );

    await recordAudit(
      {
        actorUserId: actor.id,
        action: "user.two_factor_enabled",
        entityType: "user",
        entityId: actor.id,
        after: { totp: true },
      },
      tx,
    );
  });

  return { recoveryCodes: codes };
}

/**
 * Turns it off. Requires a current code, not just a live session: otherwise
 * anyone who borrowed an unlocked laptop could remove the protection that
 * exists for exactly that case.
 */
export async function disableTwoFactor(
  actor: SessionUser | null,
  code: string,
  now: number = Date.now(),
): Promise<void> {
  if (!actor) throw new TwoFactorError("Sign in first.");

  const [current] = await db
    .select({
      secret: users.totpSecret,
      confirmedAt: users.totpConfirmedAt,
      lastUsedStep: users.totpLastUsedStep,
    })
    .from(users)
    .where(eq(users.id, actor.id));

  if (!current?.secret || !current.confirmedAt) {
    throw new TwoFactorError("Two-factor authentication is not on.");
  }

  const bySecret = verifyTotp(current.secret, code, {
    now,
    lastUsedStep: current.lastUsedStep,
  });

  const accepted = bySecret.valid || (await consumeRecoveryCode(actor.id, code));

  if (!accepted) {
    throw new TwoFactorError("That code is not right.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        totpSecret: null,
        totpConfirmedAt: null,
        totpLastUsedStep: null,
        updatedAt: new Date(now),
      })
      .where(eq(users.id, actor.id));

    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, actor.id));

    await recordAudit(
      {
        actorUserId: actor.id,
        action: "user.two_factor_disabled",
        entityType: "user",
        entityId: actor.id,
        before: { totp: true },
        after: { totp: false },
      },
      tx,
    );
  });
}

/** Whether this account must produce a second factor to sign in. */
export async function requiresTwoFactor(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ confirmedAt: users.totpConfirmedAt })
    .from(users)
    .where(eq(users.id, userId));

  return Boolean(row?.confirmedAt);
}

export type TwoFactorStatus = {
  enabled: boolean;
  enrolling: boolean;
  remainingRecoveryCodes: number;
};

export async function getTwoFactorStatus(
  actor: SessionUser | null,
): Promise<TwoFactorStatus> {
  if (!actor) {
    return { enabled: false, enrolling: false, remainingRecoveryCodes: 0 };
  }

  const [row] = await db
    .select({ secret: users.totpSecret, confirmedAt: users.totpConfirmedAt })
    .from(users)
    .where(eq(users.id, actor.id));

  const unused = await db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(
      and(eq(recoveryCodes.userId, actor.id), isNull(recoveryCodes.usedAt)),
    );

  return {
    enabled: Boolean(row?.confirmedAt),
    enrolling: Boolean(row?.secret) && !row?.confirmedAt,
    remainingRecoveryCodes: unused.length,
  };
}

/**
 * Spends a recovery code if it matches an unused one. Compared in constant
 * time and marked used in the same statement that selects it, so the same code
 * cannot be spent twice by two simultaneous attempts.
 */
export async function consumeRecoveryCode(
  userId: string,
  code: string,
): Promise<boolean> {
  const candidate = normaliseRecoveryCode(code);
  if (candidate.length === 0) return false;

  const hash = hashRecoveryCode(candidate);

  const spent = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, hash),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });

  return spent.length > 0;
}

export type SecondFactorResult = {
  accepted: boolean;
  /** True when a recovery code was spent rather than an app code used. */
  usedRecoveryCode: boolean;
};

/**
 * Checks the second factor at sign-in. Either a code from the app or one
 * recovery code; a spent code is refused, and a code from a step already used
 * is refused as a replay.
 */
export async function verifySecondFactor(
  userId: string,
  code: string,
  now: number = Date.now(),
): Promise<SecondFactorResult> {
  const [row] = await db
    .select({
      secret: users.totpSecret,
      confirmedAt: users.totpConfirmedAt,
      lastUsedStep: users.totpLastUsedStep,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!row?.secret || !row.confirmedAt) {
    return { accepted: false, usedRecoveryCode: false };
  }

  const result: TotpVerification = verifyTotp(row.secret, code, {
    now,
    lastUsedStep: row.lastUsedStep,
  });

  if (result.valid) {
    // Recorded before the session is upgraded, so the same code cannot be used
    // again even by a request already in flight.
    await db
      .update(users)
      .set({ totpLastUsedStep: result.step, updatedAt: new Date(now) })
      .where(eq(users.id, userId));

    return { accepted: true, usedRecoveryCode: false };
  }

  if (await consumeRecoveryCode(userId, code)) {
    return { accepted: true, usedRecoveryCode: true };
  }

  return { accepted: false, usedRecoveryCode: false };
}

/** Exposed for tests: the comparison used on recovery codes. */
export function recoveryCodesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(hashRecoveryCode(a), "hex");
  const bufferB = Buffer.from(hashRecoveryCode(b), "hex");
  return timingSafeEqual(bufferA, bufferB);
}
