/**
 * Signing in with Google (DECISIONS.md D-042).
 *
 * Two halves are covered here: reading an ID token, which is the only place a
 * value from outside is trusted, and what linking does to accounts — matching
 * on the provider's subject, linking a verified address to an existing
 * account, and never handing out a role.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { oauthAccounts, users } from "@/db/schema";
import {
  authenticate,
  CredentialsError,
  signInWithGoogle,
} from "@/lib/auth/accounts";
import {
  buildAuthorizationUrl,
  googleConfig,
  googleRedirectUri,
  GoogleSignInError,
  readIdTokenClaims,
} from "@/lib/auth/google";
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
  await harness.reset();
});

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const validClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "108423",
  email: "Shopper@Example.com",
  email_verified: true,
  given_name: "Nadia",
  family_name: "Rahman",
  exp: Math.floor(Date.now() / 1000) + 300,
  ...overrides,
});

describe("configuration", () => {
  it("is off until both credentials are set", () => {
    const before = { ...process.env };
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(googleConfig()).toBeNull();

    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    expect(googleConfig()).toBeNull();

    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(googleConfig()).toEqual({
      clientId: CLIENT_ID,
      clientSecret: "secret",
    });

    // A host that lists the names it found hands blanks through; blank is
    // "not configured", not "configured as empty".
    process.env.GOOGLE_CLIENT_SECRET = "  ";
    expect(googleConfig()).toBeNull();

    process.env = before;
  });

  it("derives the callback from the site's own origin", () => {
    const before = process.env.GOOGLE_REDIRECT_URI;
    delete process.env.GOOGLE_REDIRECT_URI;

    expect(googleRedirectUri("https://shop.example.com/")).toBe(
      "https://shop.example.com/api/auth/google/callback",
    );

    process.env.GOOGLE_REDIRECT_URI = "https://other.example.com/cb";
    expect(googleRedirectUri("https://shop.example.com")).toBe(
      "https://other.example.com/cb",
    );

    if (before === undefined) delete process.env.GOOGLE_REDIRECT_URI;
    else process.env.GOOGLE_REDIRECT_URI = before;
  });

  it("asks for a code with PKCE and no implicit tokens", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: CLIENT_ID,
        redirectUri: "https://shop.example.com/api/auth/google/callback",
        state: "state-value",
        codeChallenge: "challenge-value",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });
});

describe("reading an ID token", () => {
  it("accepts one issued by Google for this application", () => {
    const profile = readIdTokenClaims(idToken(validClaims()), CLIENT_ID);

    expect(profile.subject).toBe("108423");
    expect(profile.email).toBe("shopper@example.com");
    expect(profile.emailVerified).toBe(true);
    expect(profile.firstName).toBe("Nadia");
  });

  it("refuses one minted for another application", () => {
    expect(() =>
      readIdTokenClaims(idToken(validClaims({ aud: "someone-else" })), CLIENT_ID),
    ).toThrow(GoogleSignInError);
  });

  it("refuses one from another issuer", () => {
    expect(() =>
      readIdTokenClaims(
        idToken(validClaims({ iss: "https://evil.example.com" })),
        CLIENT_ID,
      ),
    ).toThrow(GoogleSignInError);
  });

  it("refuses an expired one", () => {
    expect(() =>
      readIdTokenClaims(
        idToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 })),
        CLIENT_ID,
      ),
    ).toThrow(GoogleSignInError);
  });

  it("refuses a malformed one", () => {
    expect(() => readIdTokenClaims("not-a-token", CLIENT_ID)).toThrow(
      GoogleSignInError,
    );
  });
});

describe("signing in", () => {
  const profile = {
    subject: "108423",
    email: "shopper@example.com",
    emailVerified: true,
    firstName: "Nadia",
    lastName: "Rahman",
  };

  it("creates a customer the first time, and signs them in", async () => {
    const { session, user, needsSecondFactor } = await signInWithGoogle(profile);

    expect(needsSecondFactor).toBe(false);
    expect(user.role).toBe("customer");

    const live = await validateSessionToken(session.token);
    expect(live?.user.email).toBe("shopper@example.com");

    const [row] = await harness.db
      .select({
        passwordHash: users.passwordHash,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.email, "shopper@example.com"));

    // No password at all, rather than one nobody knows.
    expect(row.passwordHash).toBeNull();
    expect(row.emailVerifiedAt).not.toBeNull();
  });

  it("returns to the same account on the second visit", async () => {
    const first = await signInWithGoogle(profile);
    const second = await signInWithGoogle(profile);

    expect(second.user.id).toBe(first.user.id);

    const links = await harness.db.select().from(oauthAccounts);
    expect(links).toHaveLength(1);
  });

  it("follows the subject, not the address, when the address changes", async () => {
    const first = await signInWithGoogle(profile);
    const second = await signInWithGoogle({
      ...profile,
      email: "renamed@example.com",
    });

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe("shopper@example.com");
  });

  it("links to an account that already holds the verified address", async () => {
    const [existing] = await harness.db
      .insert(users)
      .values({
        email: "shopper@example.com",
        passwordHash: "x",
        role: "customer",
      })
      .returning({ id: users.id });

    const { user } = await signInWithGoogle(profile);

    expect(user.id).toBe(existing.id);

    const [link] = await harness.db.select().from(oauthAccounts);
    expect(link.userId).toBe(existing.id);
  });

  it("refuses an unverified address", async () => {
    await expect(
      signInWithGoogle({ ...profile, emailVerified: false }),
    ).rejects.toBeInstanceOf(CredentialsError);

    const rows = await harness.db.select().from(users);
    expect(rows).toHaveLength(0);
  });

  it("keeps the second factor in front of a staff account", async () => {
    const [staff] = await harness.db
      .insert(users)
      .values({
        email: "staff@example.com",
        passwordHash: "x",
        role: "staff_admin",
        totpSecret: "JBSWY3DPEHPK3PXP",
        totpConfirmedAt: new Date(),
      })
      .returning({ id: users.id });

    const { session, needsSecondFactor, user } = await signInWithGoogle({
      ...profile,
      email: "staff@example.com",
    });

    expect(user.id).toBe(staff.id);
    expect(needsSecondFactor).toBe(true);
    // A pending session authenticates nothing until the code is proved.
    expect(await validateSessionToken(session.token)).toBeNull();
  });

  it("never lets a password sign in to a Google-only account", async () => {
    await signInWithGoogle(profile);

    await expect(
      authenticate({ email: "shopper@example.com", password: "" }),
    ).rejects.toBeInstanceOf(CredentialsError);

    await expect(
      authenticate({
        email: "shopper@example.com",
        password: "any-password-at-all",
      }),
    ).rejects.toBeInstanceOf(CredentialsError);
  });
});
