import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { oauthAccounts, users } from "@/db/schema";
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

  /*
   * An account that only ever signed in with Google has no hash. It is
   * refused exactly like a wrong password — same message, same cost — so the
   * response never reveals how someone else signs in.
   */
  if (!user.passwordHash) {
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
export async function register(
  input: Omit<RegisterInput, "firstName" | "lastName"> & {
    firstName?: string;
    lastName?: string;
  },
) {
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
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      passwordHash,
      role: "customer",
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  const session = await createSession(created.id);

  return { session, user: created };
}

/**
 * Signs in the holder of a verified Google identity, per DECISIONS.md D-042.
 *
 * Three cases, in order:
 *   1. the Google subject is already linked — that account signs in;
 *   2. an account exists with the same email — the identity is linked to it,
 *      which is safe only because Google is asked for, and this is only
 *      called with, a *verified* address;
 *   3. nobody matches — a new customer is created with no password, exactly
 *      like self-registration, which never grants a role.
 *
 * A second factor still applies: an account with TOTP configured gets a
 * pending session here too, so Google cannot be used to walk past it.
 */
export async function signInWithGoogle(profile: {
  subject: string;
  email: string;
  emailVerified: boolean;
  firstName?: string | null;
  lastName?: string | null;
}) {
  if (!profile.emailVerified) {
    // Without a verified address there is nothing safe to match on: an
    // unverified address could be anyone's.
    throw new CredentialsError();
  }

  const email = profile.email.trim().toLowerCase();

  const [linked] = await db
    .select({
      userId: oauthAccounts.userId,
      email: users.email,
      role: users.role,
    })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(
      and(
        eq(oauthAccounts.provider, "google"),
        eq(oauthAccounts.providerAccountId, profile.subject),
      ),
    )
    .limit(1);

  if (linked) {
    return finishOAuthSignIn({
      id: linked.userId,
      email: linked.email,
      role: linked.role,
    });
  }

  const [existing] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    await db.insert(oauthAccounts).values({
      userId: existing.id,
      provider: "google",
      providerAccountId: profile.subject,
      email,
    });

    return finishOAuthSignIn(existing);
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      firstName: profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      passwordHash: null,
      role: "customer",
      // Google only reports an address it has verified, and an unverified one
      // never reaches here.
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  await db.insert(oauthAccounts).values({
    userId: created.id,
    provider: "google",
    providerAccountId: profile.subject,
    email,
  });

  return finishOAuthSignIn(created);
}

async function finishOAuthSignIn(user: {
  id: string;
  email: string;
  role: string;
}) {
  const needsSecondFactor = await requiresTwoFactor(user.id);
  const session = await createSession(user.id, {
    pendingTwoFactor: needsSecondFactor,
  });

  return { session, needsSecondFactor, user };
}
