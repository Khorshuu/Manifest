import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, verifyPassword } from "./password";
import { createSession } from "./session";
import { requiresTwoFactor } from "./two-factor";
import type { LoginInput, RegisterInput } from "@/lib/validation/auth";

export class CredentialsError extends Error {
  readonly status = 401;

  constructor() {
    // Deliberately identical whether the email is unknown or the password is
    // wrong, so the response cannot be used to enumerate registered accounts.
    super("That email and password combination is not correct.");
    this.name = "CredentialsError";
  }
}

export class EmailTakenError extends Error {
  readonly status = 409;

  constructor() {
    super("An account with that email already exists.");
    this.name = "EmailTakenError";
  }
}

/**
 * A dummy hash of a throwaway password. Verified against when no user matches,
 * so a request for an unknown email costs the same time as one for a known
 * email and cannot be distinguished by response latency.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

export async function authenticate(input: LoginInput) {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  const user = rows[0];

  if (!user) {
    await verifyPassword(DUMMY_HASH, input.password);
    throw new CredentialsError();
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) throw new CredentialsError();

  /**
   * With a second factor configured the password alone buys a pending session,
   * which authenticates nothing until a code is proved. It is created here
   * rather than after the code so the code can be checked against a session
   * instead of against a password held somewhere in the meantime.
   */
  const needsSecondFactor = await requiresTwoFactor(user.id);
  const session = await createSession(user.id, {
    pendingTwoFactor: needsSecondFactor,
  });

  return {
    session,
    needsSecondFactor,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

/**
 * Self-registration always produces a customer. Staff and admin accounts are
 * created by a super_admin, never by this path — a client cannot ask for a
 * role here, and the schema rejects one if it somehow arrived.
 */
export async function register(input: RegisterInput) {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (existing.length > 0) throw new EmailTakenError();

  const passwordHash = await hashPassword(input.password);

  const [created] = await db
    .insert(users)
    .values({
      email: input.email,
      phone: input.phone ?? null,
      passwordHash,
      role: "customer",
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  const session = await createSession(created.id);

  return { session, user: created };
}
